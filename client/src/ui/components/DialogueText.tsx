import { useState } from 'react';

/** Long generated narration is paged rather than clipped or made scrollable. */
export function DialogueText({ text }: { text: string }) { return <Pages key={text} text={text} />; }
function Pages({ text }: { text: string }) {
  const [page, setPage] = useState(0);
  const pages = [''];
  for (const word of text.split(/\s+/)) {
    const last = pages.length - 1;
    if (pages[last]!.length + word.length > 160 && pages[last]) pages.push(word);
    else pages[last] += `${pages[last] ? ' ' : ''}${word}`;
  }
  return <><span>{pages[page]}</span>{pages.length > 1 && <span className="dialogue-pager"><button aria-label="Previous dialogue page" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button><span>{page + 1}/{pages.length}</span><button aria-label="Next dialogue page" disabled={page === pages.length - 1} onClick={() => setPage(page + 1)}>›</button></span>}</>;
}
