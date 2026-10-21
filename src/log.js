// -----------------------------------------------------------------------------
// Repeated failures are logged once: one line when they start, one when they
// end, the attempts in between at debug level only. A health check every
// 5 minutes against a broken Gladys or a read-only /data must not fill the
// logs.
// -----------------------------------------------------------------------------

/**
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} logger
 * @param {object} [options]
 * @param {'warn'|'error'} [options.level] level of the first failure
 * @param {string} [options.recovered] info line once it works again (none if omitted)
 */
export function createFailureLog(logger, { level = 'warn', recovered } = {}) {
  let failing = false;
  return {
    get failing() {
      return failing;
    },
    fail(...args) {
      if (failing) {
        logger.debug(...args);
        return;
      }
      failing = true;
      logger[level](...args);
    },
    ok() {
      if (!failing) {
        return;
      }
      failing = false;
      if (recovered) {
        logger.info(recovered);
      }
    },
  };
}
