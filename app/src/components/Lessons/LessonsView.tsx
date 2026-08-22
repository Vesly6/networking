import { useMemo, useState } from 'react';
import { LESSONS, LESSON_CATEGORIES, type Lesson } from '../../data/lessons';

/** The "Pamokos" (Lessons) tab — a static, in-app how-to-use-the-program
 * reference, on explicit request ("создать вкладку с базой данных, где
 * будут уроки ЦРМ"). Plain data (data/lessons.ts) + a two-column sidebar/
 * article layout, same shape as every other content-browsing view in this
 * app (Unibox's thread list + detail pane, LinkedIn's sub-nav + panel) —
 * no backend, no store, since this content only ever changes when a
 * developer edits lessons.ts, not something the end user edits at
 * runtime.
 *
 * A narrated video walkthrough per lesson was also asked for — out of
 * reach for this tool (no ability to record/narrate screen capture), so
 * `Lesson.videoUrl` exists as a slot for later rather than being built out
 * now: if a real video ever gets recorded and hosted somewhere, dropping
 * its URL into that field is enough for this component to render a player
 * for it (see the sections-render below) — no further code change needed
 * at that point. Until then it's always undefined and nothing shows.
 * Screenshots (`LessonSection.image`, public/lessons/*.png) fill the same
 * "show, don't just tell" need in the meantime — real, in-app captures,
 * not mockups. */
export function LessonsView() {
  const [activeId, setActiveId] = useState<string>(LESSONS[0]?.id ?? '');
  const active = useMemo(() => LESSONS.find((l) => l.id === activeId) ?? LESSONS[0], [activeId]);

  const byCategory = useMemo(() => {
    const map = new Map<string, Lesson[]>();
    for (const lesson of LESSONS) {
      const list = map.get(lesson.category) ?? [];
      list.push(lesson);
      map.set(lesson.category, list);
    }
    return map;
  }, []);

  if (!active) return null;

  return (
    <div className="lessons-view">
      <aside className="lessons-sidebar">
        {LESSON_CATEGORIES.map((category) => {
          const lessons = byCategory.get(category);
          if (!lessons || lessons.length === 0) return null;
          return (
            <div key={category} className="lessons-sidebar-group">
              <div className="lessons-sidebar-group-title">{category}</div>
              {lessons.map((lesson) => (
                <button
                  type="button"
                  key={lesson.id}
                  className={`lessons-sidebar-item ${lesson.id === active.id ? 'active' : ''}`}
                  onClick={() => setActiveId(lesson.id)}
                >
                  {lesson.title}
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      <article className="lessons-article">
        <h2 className="lessons-article-title">{active.title}</h2>
        <p className="lessons-article-summary">{active.summary}</p>

        {active.videoUrl && (
          <video className="lessons-article-video" src={active.videoUrl} controls preload="metadata" />
        )}

        {active.sections.map((section, i) => (
          <section className="lessons-section" key={i}>
            {section.heading && <h3>{section.heading}</h3>}
            {section.body.map((paragraph, j) => (
              <p key={j}>{paragraph}</p>
            ))}
            {section.image && (
              <img className="lessons-section-image" src={`/lessons/${section.image}`} alt={section.heading ?? active.title} loading="lazy" />
            )}
          </section>
        ))}
      </article>
    </div>
  );
}
