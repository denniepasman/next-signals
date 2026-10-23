// Pure helpers that make URLs, stacks and user agents safe and stable to group on.

const ID_SEGMENT_PATTERNS: readonly RegExp[] = [
  /^\d+$/u,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  /^[0-9a-f]{16,}$/iu,
  /^[0-9A-HJKMNP-TV-Z]{26}$/u, // ULID
  /^[\w-]{20,}$/u, // long opaque tokens (nanoid, base64url)
  /@|%40/u, // an e-mail address in the path
];
const PLACEHOLDER = ":id";
const MAX_PATH_LENGTH = 300;

/** `/betalen/123?x=1#y` -> `/betalen/:id`: no query, no hash, ids replaced. */
export function normalizeUrlPath(urlOrPath: string): string | null {
  const pathname = extractPathname(urlOrPath);
  if (pathname === null) {
    return null;
  }
  const normalized = pathname
    .split("/")
    .map((segment) => (isIdSegment(segment) ? PLACEHOLDER : segment))
    .join("/");
  return normalized.slice(0, MAX_PATH_LENGTH);
}

function isIdSegment(segment: string): boolean {
  return segment !== "" && ID_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment));
}

function extractPathname(urlOrPath: string): string | null {
  const trimmed = urlOrPath.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  const [beforeHash = ""] = trimmed.split("#");
  const [beforeQuery = ""] = beforeHash.split("?");
  return beforeQuery.startsWith("/") ? beforeQuery : `/${beforeQuery}`;
}

/** Stack paths relative to the project root; origins and bundler prefixes removed. */
export function relativizeStack(stack: string, projectRoot: string | null): string {
  let result = stack
    .replace(/file:\/\//gu, "")
    .replace(/webpack-internal:\/\/\/(?:\([\w-]+\)\/)?/gu, "")
    .replace(/\bhttps?:\/\/[^/\s)]+/gu, "");
  if (projectRoot !== null && projectRoot !== "" && projectRoot !== "/") {
    result = result.split(`${projectRoot}/`).join("");
  }
  return result;
}

const STACK_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.*?)(?::\d+)?(?::\d+)?\)?\s*$/u;

/** First frame outside node_modules and node internals: function and file, no line numbers. */
export function firstAppFrame(stack: string | null): string | null {
  if (stack === null) {
    return null;
  }
  for (const line of stack.split("\n")) {
    if (!/^\s*at\s/u.test(line) || /node_modules|node:|\(native\)/u.test(line)) {
      continue;
    }
    const match = STACK_FRAME.exec(line);
    if (match !== null) {
      const [, fn = "", file = ""] = match;
      return `${fn}@${file}`.slice(0, 200);
    }
  }
  return null;
}

/** Browser family and major version only: "Chrome 118". Null when nothing is recognised. */
export function parseBrowser(userAgent: string | null): string | null {
  if (userAgent === null) {
    return null;
  }
  const rules: readonly (readonly [string, RegExp])[] = [
    ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/u],
    ["Opera", /\bOPR\/(\d+)/u],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/u],
    ["Chrome", /\b(?:Chrome|CriOS)\/(\d+)/u],
    ["Safari", /\bVersion\/(\d+)[\d.]*\s+(?:Mobile\/\S+\s+)?Safari\//u],
  ];
  for (const [family, pattern] of rules) {
    const match = pattern.exec(userAgent);
    if (match?.[1] !== undefined) {
      return `${family} ${match[1]}`;
    }
  }
  return null;
}
