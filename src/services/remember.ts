/**
 * "Remember this page": the companies a saved page is about, as dictionary ids, so the extension can
 * match the note to a later page about the same company. The note itself is built by `notePage`
 * (services/llm.ts) and kept in the user's browser; the backend stores nothing.
 */
import { decide, matchText } from "../resolver/match.js";

export interface NoteCompany {
  companyId: string;
  name: string;
  ticker: string;
}

/**
 * Companies named by the model first (it read the whole page), then any the dictionary is sure of
 * in the title and text. A name the model gave is taken at the dictionary's best match, since the
 * model already decided it is a company; page text needs a confident or strong match.
 */
export function noteCompanies(named: string[], title: string, text: string, max = 5): NoteCompany[] {
  const out = new Map<string, NoteCompany>();
  const add = (c: { company: { id: string; name: string; ticker: string } }) => {
    if (!out.has(c.company.id)) out.set(c.company.id, { companyId: c.company.id, name: c.company.name, ticker: c.company.ticker });
  };
  for (const name of named) {
    const best = matchText(name, { titleLength: name.length })[0];
    if (best) add(best);
  }
  const v = decide(matchText(`${title}\n${text}`.slice(0, 8000), { titleLength: title.length }));
  if (v.kind === "confident") add(v.top);
  else if (v.kind === "multiple") v.candidates.forEach(add);
  return [...out.values()].slice(0, max);
}
