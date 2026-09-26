export const CATEGORIES = ['identity', 'progress', 'weak_topic', 'preference', 'goal', 'other'];
export const STATUSES = ['active', 'ended'];

export const EXTRACTION_PROMPT = `You extract long-term memory facts about a student from a conversation between the student ("user") and a tutoring assistant ("assistant").

Return ONLY a JSON object of this exact form:
{"facts": [{"text": "...", "category": "...", "status": "active" | "ended"}]}

Rules:
1. Extract only durable facts about the user: identity, learning progress, course topics they struggle with, learning preferences, and goals.
2. Extract only the user's CURRENT state. If the user mentions a past state and a current one ("pichle hafte Module 2 tha, ab Module 4"), extract only the current one. Never store the past state.
3. Status:
   - "active": the fact is true now. Almost every fact is active.
   - "ended": the user says something is NO LONGER true ("ab mujhe DP mein dikkat nahi hai"). Output the fact that ended, written exactly the way it would have been stored while it was true, with status "ended". Example: {"text": "User struggles with dynamic programming (DP)", "category": "weak_topic", "status": "ended"}. Never store an ended fact as a new active fact.
4. Read assistant messages only as context for understanding the user's replies. If the assistant asks "Which module are you on?" and the user answers "3", extract "User is on Module 3". Never extract facts about the assistant or what the assistant explained.
5. Skip facts about other people (friends, siblings, classmates, roommates), even when they are mixed with facts about the user in the same message.
6. Skip hypotheticals and wishes about a different situation ("agar main Module 5 pe hota...").
7. Read sarcasm and jokes for their real meaning. "haan recursion toh bahut easy hai... 3 din se atka hoon" means the user struggles with recursion. Never store the literal joke.
8. weak_topic is only for course or technical topics. Difficulty with a human language (English, Hindi, ...) is not a weak_topic: store the language the user wants instead, as a preference ("User prefers explanations in Hindi").
9. One fact per item. If a sentence contains several facts, split it.
10. Always write facts in English, in the third person, starting with "User", even when the conversation is in Hindi, Hinglish or another language.
11. Use this fixed phrasing, so the same fact is always worded the same way:
    - identity: "User's name is X", "User prefers to be called X", "User is a <year/role>"
    - progress: "User is on Module N", "User has completed Module N"
    - weak_topic: "User struggles with <topic>"
    - preference: "User prefers <...>"
    - goal: "User wants to <...>"
    - other: a short plain sentence starting with "User"
12. Use the full topic name, with the user's abbreviation in brackets if they used one: "dynamic programming (DP)". Keep names and numbers exactly as the user said them.
13. Ignore greetings, thanks, small talk, and questions about course content that do not reveal anything about the user. "what is recursion?" alone is not a fact; "I don't understand recursion" is.
14. If the user corrects themselves, extract only the corrected information.
15. If there is nothing worth remembering, return {"facts": []}.
16. Give each fact exactly one category:
   - identity: who the user is (name, nickname, year, college, background)
   - progress: where the user currently is in the course, or what they have completed
   - weak_topic: a course or technical topic the user struggles with
   - preference: how the user likes to learn (language, explanation style, examples, format, pace)
   - goal: what the user wants to achieve
   - other: a durable fact about the user that fits none of the above

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

Conversation (language difficulty):
user: English wale technical words se confuse ho jaata hoon, Marathi mein samjhao na
Output:
{"facts": [
  {"text": "User prefers explanations in Marathi", "category": "preference", "status": "active"}
]}

Conversation (answer needs the assistant's question):
assistant: Aapko kis tarah ke examples pasand hain?
user: real-life wale
Output:
{"facts": [
  {"text": "User prefers real-life examples", "category": "preference", "status": "active"}
]}`;
