import { forceSameExtension, getExtension } from "./rename";

// Metadata vocabulary is deliberately broad. It is only applied after strong
// filename boundaries (year / episode code) have been considered, so title words
// such as "Max" or "Prime" are not blindly deleted.
const META_WORDS = [
  "1080p", "720p", "2160p", "4320p", "1440p", "4k", "8k", "2k", "10bit", "8bit",
  "hdr10+", "hdr10", "hdr", "dolby vision", "dolbyvision", "dv", "hevc", "h265", "h.265", "x265", "x264", "h264", "h.264", "avc", "av1", "mpeg4",
  "web-dl", "web dl", "webdl", "webrip", "web-rip", "web", "bluray", "blu-ray", "brrip", "bdrip", "dvdrip", "hdtv", "hdtc", "hdcam", "hdts", "cam", "line", "pre-hd", "ds4k", "uhd", "fhd", "remux",
  "aac", "ac3", "eac3", "dd2.0", "dd5.1", "dd7.1", "dd", "ddp", "ddp2.0", "ddp5.1", "ddp7.1", "dts-hd", "dts", "truehd", "atmos",
  "dual audio", "dual-audio", "multiaudio", "multi audio", "hindi", "english", "tamil", "telugu", "malayalam", "kannada", "bengali", "marathi", "punjabi", "gujarati", "urdu", "french", "german", "spanish", "korean", "japanese",
  "hin", "eng", "tam", "tel", "mal", "kan", "mar", "pun", "guj", "urd", "multi",
  "esub", "esubs", "e-sub", "e-subs", "sub", "subs", "subtitle", "subtitles", "hardsub", "hard-sub", "hc",
  "proper", "repack", "remastered", "extended", "unrated", "director's cut", "directors cut", "imax", "limited", "complete", "internal", "re-release", "re-release",
  "netflix", "nf", "mxplayer", "mx player", "youtube", "amazon prime", "prime video", "primevideo", "amzn", "amazon", "disney+", "disney plus", "hotstar", "disney+ hotstar", "jio cinema", "jiocinema", "zee5", "sonyliv", "sony liv", "apple tv+", "apple tv", "hulu", "hbo max", "max", "paramount+", "paramount plus", "lionsgate play", "aha", "sun nxt", "hoichoi", "manoramamax", "eros now", "altbalaji", "altt", "voot",
  "kattmovies", "katmovies", "katmoviehd", "katmovie", "vegamovies", "vegamovie", "moviesmod", "moviesverse", "filmyzilla", "tamilyogi", "1tamilmv", "hdhub4u", "hdhub4u.tv", "hdhub4u.ms", "hdhub4u.ag", "moviesbaba", "movies baba", "moviesflix", "moviezwap", "bollyflix", "bolly4u", "extramovies", "world4ufree", "skymovieshd", "9xmovies", "coolmoviez", "mkvcinemas", "cinevood", "cinevez", "mlwbd", "yify", "rarbg", "psa", "webshare",
  "ms", "ag", "mb"
];

const META = new RegExp(`(?:^|[ ._()\\[\\]-])(?:${META_WORDS.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|")})(?=$|[ ._()\\[\\]-])`, "gi");

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeMetadata(s: string) {
  let out = s;
  // Audio channel layouts always have an explicit separator between the two
  // digits in real release names: "5.1", "5 1", "5_1", "2.0", or a bare
  // "5ch"/"7channels" suffix. Requiring that separator (instead of making it
  // optional) is what stops this from eating plain title numbers like
  // "Ben 10", "X-Men 11", "Vadh 20" — those have no separator between the
  // two digits, so "10" is never mistaken for "1" + "0".
  out = out.replace(/\b[1257][.\s_][01]\s*(?:ch|channels?)?\b/gi, " ");
  out = out.replace(/\b[1257](?:ch|channels?)\b/gi, " ");
  out = out.replace(/\b(?:dual\s*audio|multi\s*audio|dual-audio)\b/gi, " ");
  out = out.replace(META, " ");
  // Release-group suffixes frequently occur after a hyphen, including variants
  // such as -HDHub4u.Ms / -MoviesBABA / -VegaMovies.
  out = out.replace(/\s*-\s*(?:HDHub4u(?:[._-][A-Za-z0-9]+)*|MoviesBaba|MoviesBABA|KatMovies?|KatMovieHD|VegaMovies?|Moviesmod|MoviesVerse|Filmyzilla|TamilYogi|1TamilMV|YIFY|RARBG|PSA)\s*$/i, " ");
  return out;
}

function cleanPunctuation(s: string) {
  return s
    .replace(/[\[{]/g, "(")
    .replace(/[\]}]/g, ")")
    .replace(/\s*[._]+\s*/g, " ")
    .replace(/\s+[-–—]\s*|\s*[-–—]\s+/g, " - ")
    .replace(/\s*\/\s*/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\(\s*\)/g, "")
    .trim();
}

function extractYear(s: string) {
  const matches = [...s.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

function normalizeEpisode(titlePart: string, ext: string) {
  const ep = titlePart.match(/\bS(\d{1,2})\s*(?:E|Ep)\s*(\d{1,3})\b/i);
  if (!ep || ep.index === undefined) return null;
  const before = titlePart.slice(0, ep.index).trim();
  const after = titlePart.slice(ep.index + ep[0].length).trim();
  const series = cleanPunctuation(removeMetadata(before));
  const episode = `S${ep[1].padStart(2, "0")}E${ep[2].padStart(2, "0")}`;
  const episodeTitle = extractEpisodeTitle(after);
  const final = episodeTitle ? `${series} - ${episode} - ${episodeTitle}` : `${series} - ${episode}`;
  return `${final}${ext}`;
}

// Recovers the human episode title that sits between the SxxExx code and
// the first metadata token (resolution, codec, language, release group...),
// e.g. "...S01E02.Ben.10.Returns.Part.2.720p.x265..." -> "Ben 10 Returns Part 2".
// This only ever surfaces text that was already in the source filename —
// nothing is invented — so it stays safe for the strict number-matching
// guard in hybridNormalize below.
function extractEpisodeTitle(after: string) {
  const text = after.replace(/^[\s._-]+/, "");
  META.lastIndex = 0;
  const metaIdx = text.search(META);
  META.lastIndex = 0;
  const chunk = metaIdx >= 0 ? text.slice(0, metaIdx) : text;
  const title = cleanPunctuation(chunk).replace(/^[-\s]+|[-\s]+$/g, "").trim();
  if (title.length < 2 || !/[A-Za-z]/.test(title)) return "";
  return title;
}

function formatMovieTitle(title: string) {
  title = cleanPunctuation(removeMetadata(title));
  title = title.replace(/\s+-\s+(?:\([^)]*\))$/g, "").trim();
  // "Avengers 4 Endgame" -> "Avengers 4 - Endgame". Only do this when a
  // small integer sits between two non-numeric title segments. This does not
  // remove numbers from titles such as "Vadh 2" or "The Fantastic 4".
  const m = title.match(/^(.*?\b)([1-9]|1[0-9]|20)\s+(.+)$/);
  if (m && m[1].trim() && m[3].trim() && !/^\d+$/.test(m[3].trim())) {
    const prefix = m[1].trim();
    const rest = m[3].trim();
    // Avoid converting ordinary numeric title phrases where the number is
    // clearly the final title token.
    if (!/^\d/.test(rest)) title = `${prefix} ${m[2]} - ${rest}`;
  }
  title = title
    .replace(/\s+-\s+-\s+/g, " - ")
    .replace(/^[-–—]+|[-–—]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title;
}

function cleanCore(raw: string, kind: "file" | "folder") {
  const ext = kind === "file" ? getExtension(raw) : "";
  let base = kind === "file" ? raw.slice(0, raw.length - ext.length) : raw;
  // Preserve SxxExx before any generic numeric/audio cleanup.
  const episode = normalizeEpisode(base, ext);
  if (episode) return episode;
  // A TV folder often contains S01 but no E##. The season belongs to the
  // contained episode filenames, not the folder name.
  if (kind === "folder") base = base.replace(/\bS\d{1,2}\b/gi, " ");
  // Remove bracketed release metadata, but preserve a year in parentheses.
  base = base.replace(/\((?!(?:19\d{2}|20\d{2})\b)[^()]*\)/g, " ");
  base = base.replace(/\b(?:19\d{2}|20\d{2})\b/g, " __YEAR__ ");
  base = removeMetadata(base);
  base = base.replace(/__YEAR__/g, " ");
  const year = extractYear(raw);
  let title = formatMovieTitle(base);
  if (!title) title = formatMovieTitle(raw.replace(ext, ""));
  const finalBase = year ? `${title} (${year})` : title;
  return `${finalBase}${ext}`.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

export function hybridNormalize(original: string, llmCandidate: string, kind: "file" | "folder") {
  const deterministic = cleanCore(original, kind);
  const candidateText = llmCandidate.trim();
  if (!candidateText) return deterministic;
  // IMPORTANT: the LLM response is the primary proposed name. We only apply
  // hard safety checks here, then trust the model's answer — re-running the
  // AI candidate through the lossy deterministic parser used to silently
  // discard perfectly good Ollama answers.
  const candidate = kind === "file"
    ? forceSameExtension(original, candidateText)
    : candidateText;
  if (!candidate) return deterministic;
  if (!isWindowsSafeCandidate(candidate)) return deterministic;
  if (kind === "file" && getExtension(candidate) !== getExtension(original)) {
    return deterministic;
  }
  // The year, when confidently detected from the source, must not be changed
  // or duplicated by the model.
  const originalYear = extractYear(original);
  if (originalYear) {
    const candidateYears = [...candidate.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => m[1]);
    if (candidateYears.length !== 1 || candidateYears[0] !== originalYear) {
      return deterministic;
    }
  }
  // Preserve explicit semantic numbers from the deterministic parser. This
  // protects titles such as Vadh 2, The Fantastic 4 and X-Men 10.
  const detBase = kind === "file"
    ? deterministic.slice(0, deterministic.length - getExtension(deterministic).length)
    : deterministic;
  const candBase = kind === "file"
    ? candidate.slice(0, candidate.length - getExtension(candidate).length)
    : candidate;
  const detSemanticNums = (detBase.match(/\b\d+\b/g) || []).filter(n => !/^20\d{2}$|^19\d{2}$/.test(n)).sort();
  const candSemanticNums = (candBase.match(/\b\d+\b/g) || []).filter(n => !/^20\d{2}$|^19\d{2}$/.test(n)).sort();
  if (detSemanticNums.join(",") !== candSemanticNums.join(",")) return deterministic;
  // Folders must never keep a bare season marker (S01, S1...) — the prompt
  // explicitly asks for it to be stripped, since season/episode belongs on
  // the files, not the folder. A token like "S01" is attached directly to
  // its digits with no word boundary between them, so the semantic-number
  // check above can't see it and the model can let it slip through
  // (e.g. "Operation Safed Sagar S01"). Catch that case explicitly.
  if (kind === "folder") {
    const hasEpisodeCode = (s: string) => /\bS\d{1,2}\s*E\d{1,3}\b/i.test(s);
    const hasBareSeason = (s: string) => /\bS\d{1,2}\b/i.test(s) && !hasEpisodeCode(s);
    if (hasBareSeason(candBase) && !hasBareSeason(detBase)) return deterministic;
  }
  // Never allow obvious release metadata in the final LLM proposal.
  META.lastIndex = 0;
  if (META.test(candBase)) {
    META.lastIndex = 0;
    return deterministic;
  }
  META.lastIndex = 0;
  return candidate;
}

function isWindowsSafeCandidate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/[\\/:*?"<>|]/.test(trimmed) || /[. ]$/.test(trimmed)) return false;
  if (trimmed === "." || trimmed === "..") return false;
  return true;
}

export function deterministicNormalize(original: string, kind: "file" | "folder") {
  return cleanCore(original, kind);
}
