// Ask a question with buttons (ADR 0065). Pure functions only: app.js owns the page. A question
// is a message with `to` and `choices`; the addressed name answers with a reply carrying `answer`.

/** The message's choices when it is a question, else null. Anything malformed is not a question. */
export function choicesOf(message) {
  const choices = message?.choices;
  if (!Array.isArray(choices) || choices.length < 2 || !choices.every((c) => typeof c === "string"))
    return null;
  return choices;
}

/** The answer record a reply sets on its question, or null when the reply is not an answer. */
export function answeredBy(reply) {
  if (typeof reply?.answer !== "string" || reply.replyTo == null) return null;
  return { id: reply.id, choice: reply.answer, username: reply.username, answeredAt: reply.createdAt };
}

/**
 * How a question's buttons show for `me`: "answered" (locked, the choice marked), "open" (`me`
 * may tap one), or "waiting" (someone else is asked). The server enforces the same rules.
 */
export function choiceState(message, me, { interactive = true } = {}) {
  if (message.answered) return "answered";
  return interactive && typeof me === "string" && me === message.to ? "open" : "waiting";
}

/** The POST body of an answer: a reply whose text is the choice. */
export function answerBody(username, question, choice) {
  return { username, text: choice, replyTo: question.id, answer: choice };
}
