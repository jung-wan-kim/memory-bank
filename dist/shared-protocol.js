export const CONTROL_PREFIX = '{"mb_relay":';
/**
 * Exit codes of the server process — what the relay that started it reads.
 *  76  another live server has the name: connect to that one
 *  75  the name could not be had right now: try again later
 *  70  the server cannot run here (modules missing, native addon broken, bad environment): a start failure
 * Anything else before the server answers on its socket is a start failure too — a crash, a signal, and also
 * a plain 0: a server that ends without having served and without saying why did not start. (0 is how a
 * server ends after it served: idle, retired, or told to stop.)
 */
export const EXIT_START_FAILED = 70;
export const EXIT_RETRY = 75;
export const EXIT_NAME_TAKEN = 76;
/** A timing both sides read from the environment: a positive number of milliseconds, else the default. */
export function positiveMs(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
