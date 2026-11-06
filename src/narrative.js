// Turns the collected numbers into a short "how the week went" note.
// The numbers are always shown on the page; this only adds a reading of them,
// so any failure here returns null and the review is sent without it.
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You write a short Sunday-evening weekly review for one person, from JSON their own apps produced: nutrition (Macrovana), lifting (Rep, Mix, Burn), spending, a daily habits checklist (Ritual Cue), and a shared family planner (Week of Us).

Write about 150 words of plain prose, no headings or bullet points, addressed to the reader as "you":
- Open with one sentence on the overall shape of the week.
- Then make two or three specific observations. Prefer ones that connect sources (for example protein against training volume, sleep against workouts, spending against planner events) or that compare with last week, the 8-week spending baseline, or the stated targets. Use the actual numbers.
- End with one concrete, small thing worth doing next week, drawn from the data (an overdue or stuck task, a slipping habit, a target gap).

Rules:
- Use only facts in the JSON. Do not guess at causes the data does not show.
- A source with status other than "ok" is missing; mention it in at most a few words, or not at all.
- Nutrition averages count only days marked Complete. If few days are Complete, say the average is thin rather than treating it as reliable.
- If spending.importsLagging is true, transactions have not all been imported yet, so do not call the week cheap.
- The review may run on Sunday evening, before the day is over; treat Sunday as partial.
- No medical, diet, or financial advice beyond restating the person's own targets. No praise filler.`;

export async function writeNarrative(review, { model, client = new Anthropic() } = {}) {
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      // If a safety classifier declines, re-run on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Week of ${review.week.start} to ${review.week.end}.\n\n${JSON.stringify(review.sources)}`,
      }],
    });
    if (response.stop_reason === 'refusal') {
      console.warn('[narrative] declined:', response.stop_details?.category ?? 'unknown');
      return null;
    }
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return text ? { text, model: response.model } : null;
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`[narrative] API error ${error.status ?? ''}: ${error.message}`);
    } else {
      console.error('[narrative] failed:', error);
    }
    return null;
  }
}

export { SYSTEM as _SYSTEM_PROMPT };
