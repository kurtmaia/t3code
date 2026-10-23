import remarkMath from "remark-math";

// Wraps the inline construct of micromark-extension-math 3.x (via remark-math 6).
// It relies on that version calling `effects.enter("mathText")` as the first
// event of its tokenizer and on `micromarkExtensions` being a mutable array;
// if either changes the guard falls through to plain math rather than failing.

type MicromarkCode = number | null;
type MicromarkState = (code: MicromarkCode) => MicromarkState | undefined;

interface MicromarkToken {
  readonly type: string;
}

/** The slice of micromark's tokenizer context this guard reads. */
interface MicromarkTokenizeContext {
  readonly events: ReadonlyArray<readonly [string, MicromarkToken, unknown]>;
  sliceSerialize(token: MicromarkToken): string;
}

/** A micromark construct, narrowed to what wrapping one needs. */
interface MicromarkConstruct {
  tokenize: (
    this: MicromarkTokenizeContext,
    effects: unknown,
    ok: MicromarkState,
    nok: MicromarkState,
  ) => MicromarkState;
}

interface MicromarkSyntaxExtension {
  text?: Record<number, MicromarkConstruct | MicromarkConstruct[]>;
}

interface MicromarkProcessor {
  data(key: "micromarkExtensions"): MicromarkSyntaxExtension[] | undefined;
}

const DOLLAR_SIGN = 36;
const DIGIT_ZERO = 48;
const DIGIT_NINE = 57;

function isDigit(code: MicromarkCode | undefined): boolean {
  return code != null && code >= DIGIT_ZERO && code <= DIGIT_NINE;
}

/**
 * Pandoc's test for telling prose apart from `$…$` math, applied to the source
 * the tokenizer just claimed plus the character that follows it: the opening
 * `$` must be followed by a non-space, the closing `$` must be preceded by a
 * non-space, and the closing `$` must not be followed by a digit.
 * `$3,230 linehaul + $1,566.55 fuel` fails on the space, `= **$2,973.01**`
 * fails on the digit, and `$w_i = \exp(t_i)$` passes all three.
 */
function readsAsCurrency(claimed: string, following: MicromarkCode): boolean {
  // Nobody writes an amount as `$$5$$`, so display math stays permissive and
  // keeps its padded `$$ x $$` form.
  if (claimed.startsWith("$$")) {
    return false;
  }
  const inner = claimed.slice(1, -1);
  return inner.length === 0 || /^\s|\s$/.test(inner) || isDigit(following);
}

/**
 * remark-math, plus a guard that keeps dollar amounts out of math. Agents talk
 * about money constantly, and a paragraph holding two amounts otherwise
 * typesets everything between them — swallowing the emphasis markers in there,
 * so the text loses its bold as well as its dollar signs.
 *
 * The guard wraps the `$` text construct remark-math just registered rather
 * than repairing the tree afterwards: by then the math span has already eaten
 * that markup. A rejected opener falls back to plain text, so a later `$` on
 * the same line still gets its own chance to open real math.
 */
export const remarkCurrencySafeMath: typeof remarkMath = function remarkCurrencySafeMath(
  this: MicromarkProcessor,
  options,
) {
  remarkMath.call(this, options);

  for (const extension of this.data("micromarkExtensions") ?? []) {
    const text = extension.text;
    const registered = text?.[DOLLAR_SIGN];
    if (text === undefined || registered === undefined) {
      continue;
    }

    const constructs = Array.isArray(registered) ? registered : [registered];
    text[DOLLAR_SIGN] = constructs.map(
      (construct): MicromarkConstruct => ({
        ...construct,
        tokenize(effects, ok, nok) {
          // Where the construct's own `enter` lands, so the token found there
          // spans the whole `$…$` once the tokenizer exits it.
          const enterIndex = this.events.length;

          const guardedOk: MicromarkState = (code) => {
            const token = this.events[enterIndex]?.[1];
            if (token === undefined || token.type !== "mathText") {
              return ok(code);
            }
            return readsAsCurrency(this.sliceSerialize(token), code) ? nok(code) : ok(code);
          };

          return construct.tokenize.call(this, effects, guardedOk, nok);
        },
      }),
    );
  }
};
