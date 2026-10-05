import { SOURCES } from "../sources/registry";
import { cachedSearch } from "../sources/cache";
import { dedupeResults } from "../ui/dedupe";
import { defaultOrder } from "../ui/sort";
import type { PlusConfig } from "./config";
import type { TorrentResult } from "../sources/types";
export interface SearchResponse { results: TorrentResult[]; errors: { source: string; message: string }[] }
export async function search(query: string, config: PlusConfig, signal?: AbortSignal): Promise<SearchResponse> {
  const groups = { games: "Games", movies: "Movies", tv: "TV", anime: "Anime" } as const;
  const selected = SOURCES.filter(s => config.enabledSources.includes(s.id) && (config.category === "all" || s.groups?.includes(groups[config.category])));
  const timeout = AbortSignal.timeout(config.searchTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const attempts = await Promise.all(selected.map(async source => {
    try { return { results: await cachedSearch(source, query, { signal: combined }), error: null }; }
    catch { return { results: [], error: { source: source.id, message: combined.aborted ? "Search timed out or was cancelled" : "Source unavailable" } }; }
  }));
  return { results: defaultOrder(dedupeResults(attempts.flatMap(a => a.results))), errors: attempts.flatMap(a => a.error ? [a.error] : []) };
}
