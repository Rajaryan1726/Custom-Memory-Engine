export const CATEGORIES = ['identity', 'progress', 'weak_topic', 'preference', 'goal', 'other'];
export const STATUSES = ['active', 'ended'];

export const EXTRACTION_PROMPT = `You extract long-term memory facts about a student from a conversation between the student ("user") and a tutoring assistant ("assistant").

Return ONLY a JSON object of this exact form:
{"facts": [{"text": "...", "category": "...", "status": "active" | "ended"}]}

Rules:
1. Extract only durable facts about the user: identity, learning progress (module and current topic), course topics they struggle with, learning preferences, goals, and interests or hobbies (they help the tutor pick examples).
2. Extract only the user's CURRENT state. If the user mentions a past state and a current one ("pichle hafte Module 2 tha, ab Module 4"), extract only the current one. Never store the past state.
3. Status:
   - "active": the fact is true now. Almost every fact is active.
   - "ended": the user says something is NO LONGER true ("ab mujhe DP mein dikkat nahi hai"). Output the fact that ended, written exactly the way it would have been stored while it was true, with status "ended". Example: {"text": "User struggles with dynamic programming (DP)", "category": "weak_topic", "status": "ended"}. Never store an ended fact as a new active fact.
4. Read assistant messages only as context for understanding the user's replies. If the assistant asks "Which module are you on?" and the user answers "3", extract "User is on Module 3". Never extract facts about the assistant or what the assistant explained.
5. Skip facts about other people (friends, siblings, classmates, roommates), even when they are mixed with facts about the user in the same message.
6. Skip hypotheticals and wishes about a different situation ("agar main Module 5 pe hota...").
7. Read sarcasm and jokes for their real meaning. "haan recursion toh bahut easy hai... 3 din se atka hoon" means the user struggles with recursion. Never store the literal joke.
8. weak_topic is only for course or technical topics. Difficulty with a human language (English, Hindi, ...) is never a weak_topic:
   - Store "User prefers explanations in <language>" (preference) ONLY when the user names the language they want.
   - If the user only says a language is hard, without asking for another one, store it as category "other": "User finds <technical terms / explanations> in <language> hard to understand".
   - Never guess a preferred language the user did not name.
9. One fact per item. If a sentence contains several facts, split it.
10. Always write facts in English, in the third person, starting with "User", even when the conversation is in Hindi, Hinglish or another language.
11. Use this fixed phrasing, so the same fact is always worded the same way:
    - identity: "User's name is X", "User prefers to be called X", "User is a <year/role>", and the user's level with a technology: "User is a beginner with X", "User is comfortable with X", "User is experienced with X"
    - progress: "User is on Module N", "User has completed Module N", and for the topic the user is currently working on: "User is studying <topic>"
    - weak_topic: "User struggles with <topic>"
    - preference: "User prefers <...>"
    - goal: "User wants to <...>"
    - other: interests and hobbies as "User likes <X>"; anything else as a short plain sentence starting with "User"
12. Use the full topic name, with the user's abbreviation in brackets if they used one: "dynamic programming (DP)". Keep names and numbers exactly as the user said them.
13. Ignore greetings, thanks, small talk, and questions about course content that do not reveal anything about the user. "what is recursion?" alone is not a fact; "I don't understand recursion" is.
    - Preferences: a request about the current answer or explanation is NEVER a fact, even if it mentions a style. Signals: it points at this answer or topic ("isko", "ye", "this", "is question ko", "abhi"), or it is a one-time instruction ("explain this one in more detail").
    - Store "User prefers ..." only when the user states a lasting wish ("hamesha", "har baar", "aage se", "from now on", "always") or describes how they learn in general ("mujhe short answers se kuch samajh nahi aata"): "User prefers detailed explanations".
    - When unsure whether a request is one-time or lasting, do not store it.
    - Exception, language: a request for a language ("<language> mein samjhao", "<language> mein batao", "explain in <language>") is ALWAYS a preference, even though it looks like a request: "User prefers explanations in <language>".
    - Exception, format: a general complaint about a FORMAT of explanation (length, theory vs practice, text vs video, pace) is a preference, not "other". Store the format the user would rather have, e.g. a complaint that something is too long means the user prefers it shorter.
    - The topic the user is currently working on ("abhi <topic> kar raha hoon", "ab <topic> start kiya") is always category progress: "User is studying <topic>".
14. If the user corrects themselves, extract only the corrected information.
15. If there is nothing worth remembering, return {"facts": []}.
16. Skill level with a technology (a language, framework or tool such as TypeScript, React, Docker):
   - It is always category identity, phrased "User is a beginner with X", "User is comfortable with X" or "User is experienced with X". One fact per technology.
   - A change of level ("I'm comfortable with TypeScript now") is a NEW ACTIVE fact with the new level. Never output the old level as an "ended" fact: the new level replaces the old one.
17. The input can start with an "Earlier conversation (context only ...)" section before "Conversation:". Those messages were already processed. NEVER extract any fact from them, not even a fact that was never stored before. Extract only from the messages after "Conversation:"; use the earlier section only to understand what those messages refer to. If the messages after "Conversation:" contain no new fact, return {"facts": []}.
18. Give each fact exactly one category:
   - identity: who the user is (name, nickname, year, college, background, level with a technology)
   - progress: where the user currently is in the course (module and current topic), or what they have completed
   - weak_topic: a course or technical topic the user struggles with
   - preference: how the user likes to learn (language, explanation style, examples, format, pace)
   - goal: what the user wants to achieve
   - other: interests and hobbies, or any other durable fact about the user that fits none of the above

Examples:

Conversation:
user: Hi, main Kavya hoon, final year ECE student. Backtracking mein bahut atakti hoon
user: aur mujhe open source mein contribute karna hai
Output:
{"facts": [
  {"text": "User's name is Kavya", "category": "identity", "status": "active"},
  {"text": "User is a final year ECE student", "category": "identity", "status": "active"},
  {"text": "User struggles with backtracking", "category": "weak_topic", "status": "active"},
  {"text": "User wants to contribute to open source", "category": "goal", "status": "active"}
]}

Conversation:
user: hello!
assistant: Hi! How can I help you today?
user: kuch nahi, bas aise hi. thanks
Output:
{"facts": []}

Conversation (ended):
user: OOP pehle bilkul samajh nahi aata tha, ab clear hai
Output:
{"facts": [
  {"text": "User struggles with object-oriented programming (OOP)", "category": "weak_topic", "status": "ended"}
]}

Conversation (past vs current):
user: last month Module 8 pe tha, ab Module 11 chal raha hai
Output:
{"facts": [
  {"text": "User is on Module 11", "category": "progress", "status": "active"}
]}

Conversation (other person):
user: mera roommate Module 12 pe hai aur usko tries bahut pasand hain. main abhi Module 9 pe hoon
Output:
{"facts": [
  {"text": "User is on Module 9", "category": "progress", "status": "active"}
]}

Conversation (hypothetical):
user: agar main Module 12 pe hota to segment trees bhi aa jaate
Output:
{"facts": []}

Conversation (sarcasm):
user: wah, sliding window toh bachchon ka khel hai 🙄 2 ghante se ek hi question pe baitha hoon
Output:
{"facts": [
  {"text": "User struggles with the sliding window technique", "category": "weak_topic", "status": "active"}
]}

Conversation (language difficulty, user names the language they want):
user: English wale technical words se confuse ho jaata hoon, Marathi mein samjhao na
Output:
{"facts": [
  {"text": "User prefers explanations in Marathi", "category": "preference", "status": "active"}
]}

Conversation (language difficulty, user does NOT name a language they want):
user: lecture ki English itni bhaari lagti hai ki aadha samajh hi nahi aata
Output:
{"facts": [
  {"text": "User finds explanations in English hard to understand", "category": "other", "status": "active"}
]}

Conversation (current topic):
user: abhi union-find kar raha hoon
Output:
{"facts": [
  {"text": "User is studying union-find", "category": "progress", "status": "active"}
]}

Conversation (hobby):
user: weekends pe chess khelta hoon
Output:
{"facts": [
  {"text": "User likes chess", "category": "other", "status": "active"}
]}

Conversation (one-off request vs standing preference):
user: is answer ko thoda simple karke batao
assistant: Zaroor, ye raha simple version.
user: waise lamba text padh ke kuch yaad nahi rehta, hamesha pehle pseudo-code dikhaya karo
Output:
{"facts": [
  {"text": "User prefers seeing pseudo-code first", "category": "preference", "status": "active"}
]}

Conversation (one-off request, English):
user: can you explain this more simply?
Output:
{"facts": []}

Conversation (general complaint about a format, Hinglish):
user: theory-heavy chapters se kuch palle nahi padta, hands-on kaam jaldi dimaag mein baithta hai
Output:
{"facts": [
  {"text": "User prefers practical, hands-on explanations", "category": "preference", "status": "active"}
]}

Conversation (how the user learns in general, English):
user: honestly I only get things once I see them drawn out on a whiteboard
Output:
{"facts": [
  {"text": "User prefers visual explanations drawn out step by step", "category": "preference", "status": "active"}
]}

Conversation (completed module):
user: aaj Module 10 khatam ho gaya finally
Output:
{"facts": [
  {"text": "User has completed Module 10", "category": "progress", "status": "active"}
]}

Conversation (skill level changed):
user: Actually I'm comfortable with TypeScript now
Output:
{"facts": [
  {"text": "User is comfortable with TypeScript", "category": "identity", "status": "active"}
]}

Conversation (earlier messages are context only):
Earlier conversation (context only: already processed; NEVER extract facts from it, use it only to understand the conversation below):
user: main Farhan hoon, Kotlin seekh raha hoon
assistant: Great! Android apps bana rahe ho?

Conversation:
user: haan, ek notes app
Output:
{"facts": [
  {"text": "User is building a notes app for Android", "category": "other", "status": "active"}
]}

Conversation (earlier messages are context only, nothing new):
Earlier conversation (context only: already processed; NEVER extract facts from it, use it only to understand the conversation below):
user: I'm Sana and I'm experienced with Python

Conversation:
user: thanks!
Output:
{"facts": []}

Conversation (answer needs the assistant's question):
assistant: Aapko kis tarah ke examples pasand hain?
user: real-life wale
Output:
{"facts": [
  {"text": "User prefers real-life examples", "category": "preference", "status": "active"}
]}`;

export const DECIDER_ACTIONS = ['ADD', 'UPDATE', 'DELETE', 'NOOP'];

export const DECIDER_PROMPT = `You maintain a student's long-term memory. You receive NEW facts just extracted from a conversation, and EXISTING memories about the same student that might be related. Decide what to do with each new fact.

Input format:
- New facts: "<index>. [<category>] (<status>) <text>". status is "active" (true now) or "ended" (the student said it is no longer true).
- Existing memories: "<id>. [<category>] <text>". ids are short labels like m1, m2.

Return ONLY JSON of this form:
{"actions": [{"fact": <index>, "action": "ADD" | "UPDATE" | "DELETE" | "NOOP", "memory": "<id or null>", "text": "<final memory text, UPDATE only>"}]}

Actions:
- ADD: the fact is new information. "memory" is null.
- NOOP: an existing memory already says the same thing, even in different words. "memory" is that memory's id.
- UPDATE: the fact is a newer or more specific version of the same thing as an existing memory. "memory" is the id to replace, "text" is the new memory text (normally the new fact's text).
- DELETE: only for a fact with status "ended", when an existing memory states that same thing. "memory" is the id to delete.

Rules:
1. Progress has two separate slots:
   - module position: "User is on Module N" / "User has completed Module N"
   - current topic: "User is on <topic>" / "User is studying <topic>"
   A new module fact replaces the old module fact. A new topic fact replaces the old topic fact. A module fact never replaces a topic fact, and a topic fact never replaces a module fact.
2. Preference: a changed preference about the same aspect (explanation length, explanation language, format) replaces the old one. Preferences about different aspects are different memories.
3. Goal: a more specific version of the same goal replaces it.
4. weak_topic: different topics are different memories (recursion and graphs both stay). The same topic said again is NOOP.
5. A fact with status "ended" is never ADDed and never UPDATEs anything. If an existing memory states the same thing, DELETE it; if no existing memory matches, return NOOP with "memory": null.
6. Every new fact gets exactly one action. Each existing memory is the target of at most one UPDATE or DELETE.
7. Never touch a memory that is unrelated to the new facts.

Examples:

New facts:
0. [progress] (active) User is on Module 15
Existing memories:
m1. [progress] User is on Module 14
m2. [progress] User is studying tries
Output:
{"actions": [{"fact": 0, "action": "UPDATE", "memory": "m1", "text": "User is on Module 15"}]}

New facts:
0. [progress] (active) User is studying segment trees
Existing memories:
m1. [progress] User is on Module 16
m2. [progress] User is studying tries
Output:
{"actions": [{"fact": 0, "action": "UPDATE", "memory": "m2", "text": "User is studying segment trees"}]}

New facts:
0. [weak_topic] (active) User struggles with backtracking
Existing memories:
m1. [weak_topic] User finds backtracking problems confusing
Output:
{"actions": [{"fact": 0, "action": "NOOP", "memory": "m1"}]}

New facts:
0. [weak_topic] (ended) User struggles with bit manipulation
Existing memories:
m1. [weak_topic] User struggles with bit manipulation
m2. [weak_topic] User struggles with backtracking
Output:
{"actions": [{"fact": 0, "action": "DELETE", "memory": "m1"}]}

New facts:
0. [weak_topic] (ended) User struggles with the sliding window technique
Existing memories:
m1. [weak_topic] User struggles with tries
Output:
{"actions": [{"fact": 0, "action": "NOOP", "memory": null}]}

New facts:
0. [weak_topic] (active) User struggles with segment trees
Existing memories:
m1. [weak_topic] User struggles with backtracking
Output:
{"actions": [{"fact": 0, "action": "ADD", "memory": null}]}

New facts:
0. [preference] (active) User prefers step-by-step walkthroughs
1. [preference] (active) User prefers examples in Kotlin
Existing memories:
m1. [preference] User prefers one-line answers
m2. [preference] User prefers flowcharts over text
Output:
{"actions": [
  {"fact": 0, "action": "UPDATE", "memory": "m1", "text": "User prefers step-by-step walkthroughs"},
  {"fact": 1, "action": "ADD", "memory": null}
]}`;
