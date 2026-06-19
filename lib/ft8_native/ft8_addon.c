/**
 * ft8_native — Node.js N-API addon for native FT8/FT4 decoding.
 * Uses ft8_lib by Karlis Goba (YL3JG) for decode at native C speed.
 *
 * Exports:
 *   decode(Float32Array samples, string protocol) → [{db, dt, df, text}]
 *     protocol: "FT8" or "FT4"
 *     samples: 12000 Hz mono audio (15s for FT8, 7.5s for FT4)
 */

#include <node_api.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#include <ft8/decode.h>
#include <ft8/encode.h>
#include <ft8/message.h>
#include <ft8/constants.h>
#include <common/monitor.h>

#define MAX_CANDIDATES 140
#define MAX_DECODED 50
#define MIN_SCORE 10
#define LDPC_ITERATIONS 25
#define SAMPLE_RATE 12000

/* Callsign hash table for message unpacking */
#define HASH_SIZE 256

static struct {
    char callsign[12];
    uint32_t hash;
} hash_table[HASH_SIZE];
static int hash_table_size = 0;

static void ht_init(void) {
    hash_table_size = 0;
    memset(hash_table, 0, sizeof(hash_table));
}

static void ht_add(const char* callsign, uint32_t hash) {
    uint16_t h10 = (hash >> 12) & 0x3FFu;
    int idx = (h10 * 23) % HASH_SIZE;
    while (hash_table[idx].callsign[0] != '\0') {
        if (((hash_table[idx].hash & 0x3FFFFFu) == hash) &&
            strcmp(hash_table[idx].callsign, callsign) == 0) {
            hash_table[idx].hash &= 0x3FFFFFu;
            return;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    hash_table_size++;
    strncpy(hash_table[idx].callsign, callsign, 11);
    hash_table[idx].callsign[11] = '\0';
    hash_table[idx].hash = hash;
}

static bool ht_lookup(ftx_callsign_hash_type_t type, uint32_t hash, char* callsign) {
    uint8_t shift = (type == FTX_CALLSIGN_HASH_10_BITS) ? 12 :
                    (type == FTX_CALLSIGN_HASH_12_BITS) ? 10 : 0;
    uint16_t h10 = (hash >> (12 - shift)) & 0x3FFu;
    int idx = (h10 * 23) % HASH_SIZE;
    while (hash_table[idx].callsign[0] != '\0') {
        if (((hash_table[idx].hash & 0x3FFFFFu) >> shift) == hash) {
            strcpy(callsign, hash_table[idx].callsign);
            return true;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    callsign[0] = '\0';
    return false;
}

static ftx_callsign_hash_interface_t hash_if = {
    .lookup_hash = ht_lookup,
    .save_hash = ht_add
};

/* ---- A priori (AP) decoding -------------------------------------------------
 * To recover marginal / late-started replies addressed to us, hypothesize the
 * known bits of an incoming STANDARD message and hand them to the LDPC decoder
 * (decode.c clamps those likelihoods before belief propagation). Two passes,
 * tried only after the plain no-AP decode fails for a candidate:
 *   AP1 "mycall": call1 = our call, i3 = 1  — any reply to our CQ
 *   AP2 "both":   call1 = our call, call2 = the station we're working, i3 = 1
 *                 — mid-QSO, far more bits known (up to ~10 dB on bad channels,
 *                 Franke/Somerville/Taylor QEX 2020)
 * Masks are derived once (cached) by encoding a probe std message and lifting
 * the known field bits, so the 77-bit field layout is never hand-rolled. A
 * throwaway hash interface keeps the probe's dummy call out of the live table.
 *
 * Standard-message payload bit ranges (MSB-first, indices into plain174):
 *   call1+ipa = 0..28, call2+ipb = 29..57, ir = 58, grid15 = 59..73, i3 = 74..76 */
#define AP_CALL1_LO 0
#define AP_CALL1_HI 28
#define AP_CALL2_LO 29
#define AP_CALL2_HI 57
#define AP_I3_LO    74
#define AP_I3_HI    76

static bool ap_probe_lookup(ftx_callsign_hash_type_t t, uint32_t h, char* c) { (void)t; (void)h; c[0] = '\0'; return false; }
static void ap_probe_save(const char* c, uint32_t h) { (void)c; (void)h; }
static ftx_callsign_hash_interface_t ap_probe_hash_if = { .lookup_hash = ap_probe_lookup, .save_hash = ap_probe_save };

static char ap_cached_mycall[16] = {0};
static char ap_cached_dxcall[16] = {0};
static uint8_t ap1_mask[FTX_LDPC_N], ap1_bits[FTX_LDPC_N];
static uint8_t ap2_mask[FTX_LDPC_N], ap2_bits[FTX_LDPC_N];
static bool ap1_valid = false;
static bool ap2_valid = false;

static inline uint8_t payload_bit(const uint8_t* payload, int j) {
    return (payload[j >> 3] >> (7 - (j & 7))) & 1u;
}

/* Build an AP mask/bits pair from a probe std message. When mask_call2 is set,
 * the call2 field is fixed too. Returns false (AP unavailable) if the calls
 * don't pack as a standard i3=1 message. */
static bool ap_build(const char* call_to, const char* call_de, bool mask_call2,
                     uint8_t* mask, uint8_t* bits) {
    memset(mask, 0, FTX_LDPC_N);
    memset(bits, 0, FTX_LDPC_N);
    ftx_message_t probe;
    ftx_message_init(&probe);
    if (ftx_message_encode_std(&probe, &ap_probe_hash_if, call_to, call_de, "AA00") != FTX_MESSAGE_RC_OK)
        return false;
    if (ftx_message_get_i3(&probe) != 1)
        return false; // not a plain standard message — don't risk a wrong hypothesis
    for (int j = AP_CALL1_LO; j <= AP_CALL1_HI; ++j) { mask[j] = 1; bits[j] = payload_bit(probe.payload, j); }
    for (int j = AP_I3_LO;    j <= AP_I3_HI;    ++j) { mask[j] = 1; bits[j] = payload_bit(probe.payload, j); }
    if (mask_call2) {
        for (int j = AP_CALL2_LO; j <= AP_CALL2_HI; ++j) { mask[j] = 1; bits[j] = payload_bit(probe.payload, j); }
    }
    return true;
}

/* Refresh cached AP masks when the operator's call or QSO partner changes. */
static void ap_refresh(const char* mycall, const char* dxcall) {
    if (mycall == NULL) mycall = "";
    if (dxcall == NULL) dxcall = "";
    if (strcmp(mycall, ap_cached_mycall) == 0 && strcmp(dxcall, ap_cached_dxcall) == 0)
        return; // unchanged
    strncpy(ap_cached_mycall, mycall, sizeof(ap_cached_mycall) - 1);
    ap_cached_mycall[sizeof(ap_cached_mycall) - 1] = '\0';
    strncpy(ap_cached_dxcall, dxcall, sizeof(ap_cached_dxcall) - 1);
    ap_cached_dxcall[sizeof(ap_cached_dxcall) - 1] = '\0';
    ap1_valid = ap2_valid = false;
    if (ap_cached_mycall[0]) {
        // AP1: our call as call1, a throwaway standard call2.
        ap1_valid = ap_build(ap_cached_mycall, "K1AB", false, ap1_mask, ap1_bits);
        if (ap_cached_dxcall[0])
            ap2_valid = ap_build(ap_cached_mycall, ap_cached_dxcall, true, ap2_mask, ap2_bits);
    }
}

/* N-API decode function */
static napi_value Decode(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    if (argc < 1) {
        napi_throw_error(env, NULL, "Expected (samples, protocol?, myCall?, dxCall?)");
        return NULL;
    }

    /* Get Float32Array samples */
    float* samples;
    size_t byte_length;
    napi_typedarray_type type;
    size_t length;
    napi_value arraybuffer;
    size_t offset;
    napi_get_typedarray_info(env, args[0], &type, &length, (void**)&samples, &arraybuffer, &offset);

    if (type != napi_float32_array || length == 0) {
        napi_throw_error(env, NULL, "First argument must be a Float32Array");
        return NULL;
    }

    /* Get protocol string (default FT8) */
    ftx_protocol_t protocol = FTX_PROTOCOL_FT8;
    if (argc >= 2) {
        char proto_str[8] = {0};
        size_t proto_len;
        napi_get_value_string_utf8(env, args[1], proto_str, sizeof(proto_str), &proto_len);
        if (strcmp(proto_str, "FT4") == 0) {
            protocol = FTX_PROTOCOL_FT4;
        }
    }

    /* AP context: our callsign (args[2]) + current QSO partner (args[3]).
     * Both optional; absent/blank disables the corresponding AP pass. Reading
     * a non-string arg leaves the buffer zeroed (rc ignored on purpose). */
    char ap_mycall[16] = {0};
    char ap_dxcall[16] = {0};
    if (argc >= 3) { size_t n; napi_get_value_string_utf8(env, args[2], ap_mycall, sizeof(ap_mycall), &n); }
    if (argc >= 4) { size_t n; napi_get_value_string_utf8(env, args[3], ap_dxcall, sizeof(ap_dxcall), &n); }
    ap_refresh(ap_mycall, ap_dxcall);

    /* Set up monitor */
    monitor_config_t cfg = {
        .f_min = 200,
        .f_max = 3000,
        .sample_rate = SAMPLE_RATE,
        .time_osr = 2,
        .freq_osr = 2,
        .protocol = protocol
    };

    monitor_t mon;
    monitor_init(&mon, &cfg);

    /* Feed audio into monitor */
    int num_samples = (int)length;
    for (int pos = 0; pos + mon.block_size <= num_samples; pos += mon.block_size) {
        monitor_process(&mon, samples + pos);
    }

    /* Find candidates */
    ftx_candidate_t candidates[MAX_CANDIDATES];
    int num_candidates = ftx_find_candidates(&mon.wf, MAX_CANDIDATES, candidates, MIN_SCORE);

    /* Decode candidates */
    napi_value result_array;
    napi_create_array(env, &result_array);
    int result_count = 0;

    /* Dedup hash table for this cycle */
    ftx_message_t decoded[MAX_DECODED];
    ftx_message_t* decoded_ht[MAX_DECODED];
    memset(decoded_ht, 0, sizeof(decoded_ht));

    for (int i = 0; i < num_candidates && result_count < MAX_DECODED; i++) {
        const ftx_candidate_t* cand = &candidates[i];

        ftx_message_t message;
        ftx_decode_status_t status;
        bool is_ap = false;
        if (!ftx_decode_candidate(&mon.wf, cand, LDPC_ITERATIONS, &message, &status)) {
            /* Plain decode failed — try AP hypotheses, strongest (most bits
             * known) first. Each forces our call onto the candidate and still
             * requires the CRC to pass, so a signal NOT addressed to us simply
             * won't converge. */
            if (ap2_valid && ftx_decode_candidate_ap(&mon.wf, cand, LDPC_ITERATIONS, ap2_mask, ap2_bits, &message, &status)) {
                is_ap = true;
            } else if (ap1_valid && ftx_decode_candidate_ap(&mon.wf, cand, LDPC_ITERATIONS, ap1_mask, ap1_bits, &message, &status)) {
                is_ap = true;
            } else {
                continue;
            }
        }

        /* Check for duplicates */
        int idx_hash = message.hash % MAX_DECODED;
        bool dup = false;
        bool found_slot = false;
        do {
            if (decoded_ht[idx_hash] == NULL) {
                found_slot = true;
            } else if (decoded_ht[idx_hash]->hash == message.hash &&
                       memcmp(decoded_ht[idx_hash]->payload, message.payload, sizeof(message.payload)) == 0) {
                dup = true;
            } else {
                idx_hash = (idx_hash + 1) % MAX_DECODED;
            }
        } while (!found_slot && !dup);

        if (dup) continue;

        memcpy(&decoded[idx_hash], &message, sizeof(message));
        decoded_ht[idx_hash] = &decoded[idx_hash];

        /* Unpack message text */
        char text[FTX_MAX_MESSAGE_LENGTH];
        ftx_message_offsets_t offsets;
        ftx_message_rc_t rc = ftx_message_decode(&message, &hash_if, text, &offsets);
        if (rc != FTX_MESSAGE_RC_OK) {
            continue;
        }

        /* AP false-accept guard: an AP decode forced our call onto the bits, so
         * a genuine decode unpacks to text containing our call. If it doesn't
         * (rare AP+CRC coincidence), drop it rather than surface a bogus spot. */
        if (is_ap && ap_cached_mycall[0] && strstr(text, ap_cached_mycall) == NULL) {
            continue;
        }

        float freq_hz = (mon.min_bin + cand->freq_offset +
                        (float)cand->freq_sub / mon.wf.freq_osr) / mon.symbol_period;
        float time_sec = (cand->time_offset +
                         (float)cand->time_sub / mon.wf.time_osr) * mon.symbol_period;
        float snr = cand->score * 0.5f;

        /* Create result object {db, dt, df, text} */
        napi_value obj;
        napi_create_object(env, &obj);

        napi_value v_db, v_dt, v_df, v_text;
        napi_create_double(env, (double)snr, &v_db);
        napi_create_double(env, (double)time_sec, &v_dt);
        napi_create_double(env, (double)freq_hz, &v_df);
        napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &v_text);

        napi_value v_ap;
        napi_get_boolean(env, is_ap, &v_ap);

        napi_set_named_property(env, obj, "db", v_db);
        napi_set_named_property(env, obj, "dt", v_dt);
        napi_set_named_property(env, obj, "df", v_df);
        napi_set_named_property(env, obj, "text", v_text);
        napi_set_named_property(env, obj, "ap", v_ap);

        napi_set_element(env, result_array, result_count, obj);
        result_count++;
    }

    monitor_free(&mon);

    return result_array;
}

/* Module initialization */
static napi_value Init(napi_env env, napi_value exports) {
    ht_init();

    napi_value fn;
    napi_create_function(env, "decode", NAPI_AUTO_LENGTH, Decode, NULL, &fn);
    napi_set_named_property(env, exports, "decode", fn);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
