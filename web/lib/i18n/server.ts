import "server-only";
import { DEFAULT_LANG, dicts, type DictKey, type Lang } from "./dict";

// ponytail: the app ships English-only for the hackathon; ID strings stay in the dicts for later.
export async function getLang(): Promise<Lang> {
  return DEFAULT_LANG;
}

export async function getT() {
  const lang = await getLang();
  return { lang, t: (k: DictKey) => dicts[lang][k] };
}
