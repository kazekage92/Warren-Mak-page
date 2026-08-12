/**
 * Shared OpenAI chat.completions helper — one implementation of the fetch
 * call every LLM-backed script in this directory (extract-entities.js,
 * fact-retention-checker.js, generate-article.js, coverage-reviewer.js,
 * seo-optimizer.js) used to reimplement individually as a near-identical
 * single-attempt `fetch()` block. Each script still owns its own model
 * choice, prompt, temperature, and max_tokens sizing — this only centralizes
 * the network call itself plus the failure handling around it:
 *
 *  - retry-with-backoff (2-3 attempts by default) on transient failures —
 *    network errors, HTTP 429 (rate limit), and 5xx — honoring a numeric
 *    `Retry-After` header on 429 instead of guessing a backoff delay; never
 *    retries other 4xx (bad request, bad key, etc.), since those fail the
 *    same way every time.
 *  - a `finish_reason !== 'stop'` check that raises a clear "response
 *    truncated, consider raising max_tokens or reducing batch size" error —
 *    instead of the caller finding out three lines later as a bare
 *    `JSON.parse` failure on a cut-off string.
 *  - optional-chained access into `data.choices?.[0]?.message?.content`,
 *    throwing a clear error naming the missing field (plus finish_reason)
 *    when OpenAI's response doesn't have the shape every caller here
 *    assumes, rather than a raw "Cannot read properties of undefined".
 *
 * Every script here still calls this with `response_format: {type:
 * "json_object"}` semantics baked in (all five expect strict-JSON
 * responses) and an explicit, caller-supplied `maxTokens` — there is no
 * baked-in default, since the right size genuinely differs per use case
 * (see each script's own MAX_TOKENS constant, sized largest for the writer
 * in generate-article.js down to smallest for the judgment-only calls in
 * fact-retention-checker.js/coverage-reviewer.js).
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a failed attempt is worth retrying. `err` is set when `fetch()`
 *  itself threw (network failure); `res` is the HTTP response otherwise. */
function isRetryable({ res, err }) {
  if (err) return true;
  return res.status === 429 || res.status >= 500;
}

/** How long to wait before the next attempt. Honors a numeric `Retry-After`
 *  (seconds) on 429 when present; otherwise exponential backoff off
 *  `baseDelayMs`. */
function backoffDelayMs({ res, attempt, baseDelayMs }) {
  const retryAfter = res?.headers?.get?.('retry-after');
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return baseDelayMs * 2 ** attempt;
}

/**
 * Calls OpenAI's chat.completions endpoint with retry-with-backoff and
 * returns the response's message content string (not yet JSON.parsed — each
 * caller does its own parsing/validation of the expected response shape).
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.system
 * @param {string} args.user
 * @param {number} args.maxTokens - required; sized per use case by the caller, no default here
 * @param {number} [args.temperature=0]
 * @param {string} [args.callerLabel] - short label (e.g. "generate-article.js writer (Time Decay)")
 *   prefixed onto every error this throws, so a failure is traceable back to its call site.
 * @param {number} [args.maxAttempts] - total attempts including the first (default 3)
 * @param {number} [args.baseDelayMs] - base exponential-backoff delay (default 1000ms)
 * @returns {Promise<string>}
 */
export async function callOpenAIChat({
  apiKey,
  model,
  system,
  user,
  maxTokens,
  temperature = 0,
  callerLabel = 'OpenAI call',
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
}) {
  if (!apiKey) {
    throw new Error(`${callerLabel}: no OpenAI API key provided.`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`${callerLabel}: maxTokens must be a positive integer, got ${JSON.stringify(maxTokens)}.`);
  }

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (err) {
      lastErr = err;
      if (!isLastAttempt && isRetryable({ err })) {
        await sleep(backoffDelayMs({ attempt, baseDelayMs }));
        continue;
      }
      throw new Error(`${callerLabel}: network error calling OpenAI (attempt ${attempt + 1}/${maxAttempts}): ${err.message}`);
    }

    if (!res.ok) {
      const bodyText = await res.text();
      if (!isLastAttempt && isRetryable({ res })) {
        await sleep(backoffDelayMs({ res, attempt, baseDelayMs }));
        continue;
      }
      throw new Error(`${callerLabel}: OpenAI API error ${res.status} (attempt ${attempt + 1}/${maxAttempts}): ${bodyText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason;
    const content = choice?.message?.content;

    // Logged (not returned — every caller here treats this as a bare content string,
    // so changing the return shape would ripple through all five call sites) so real
    // completion-token usage can be observed and each script's own MAX_TOKENS constant
    // re-tuned from actual data instead of a guess.
    if (Number.isFinite(data.usage?.completion_tokens)) {
      console.log(
        `${callerLabel}: completion_tokens=${data.usage.completion_tokens}` +
          ` (prompt_tokens=${data.usage.prompt_tokens ?? '?'}, total_tokens=${data.usage.total_tokens ?? '?'})`
      );
    }

    if (finishReason !== 'stop') {
      throw new Error(
        `${callerLabel}: response truncated or incomplete (finish_reason="${finishReason ?? 'missing'}") — ` +
          'consider raising max_tokens or reducing batch size.'
      );
    }
    if (typeof content !== 'string') {
      throw new Error(
        `${callerLabel}: OpenAI response is missing "choices[0].message.content" (finish_reason="${finishReason}"): ` +
          JSON.stringify(data)
      );
    }
    return content;
  }

  // Unreachable — the loop above always either returns or throws — but keeps this
  // function's control flow explicit rather than relying on that being obvious.
  throw lastErr ?? new Error(`${callerLabel}: failed after ${maxAttempts} attempt(s).`);
}
