export const CATEGORIES = ['identity', 'progress', 'weak_topic', 'preference', 'goal', 'other'];

export const EXTRACTION_PROMPT = `You extract long-term memory facts about a student from a conversation between the student ("user") and a tutoring assistant ("assistant").

Return ONLY a JSON object of this exact form:
{"facts": [{"text": "...", "category": "..."}]}

Rules:
1. Extract only durable facts about the user: identity (name, background), learning progress (module, lesson, what they finished or are studying), topics they struggle with, learning preferences (language, explanation style, format), and goals.
2. Read assistant messages only as context for understanding the user's replies. For example, if the assistant asks "Which module are you on?" and the user answers "3", extract "User is on Module 3". Never extract facts about the assistant, and never extract what the assistant explained or suggested.
3. One fact per item. If a sentence contains several facts, split it into separate items.
4. Always write facts in English, in the third person, starting with "User", even when the conversation is in Hindi, Hinglish or another language.
5. Keep specific names, numbers and topic names exactly as the user said them (for example "Module 3", "recursion", "Raj", "DP"). Do not expand or rename them.
6. Ignore greetings, thanks, small talk, and questions about course content that do not reveal anything about the user. A question like "what is recursion?" on its own is not a fact; "I don't understand recursion" is.
7. If the user corrects themselves, extract only the corrected, final information.
8. If there is nothing worth remembering, return {"facts": []}.
9. Give each fact exactly one category from this list:
   - identity: who the user is (name, year, college, background)
   - progress: where the user is in the course or what they have completed or are studying now
   - weak_topic: a topic or concept the user struggles with or finds confusing
   - preference: how the user likes to learn (language, explanation style, examples, format, pace)
   - goal: what the user wants to achieve
   - other: a durable fact about the user that fits none of the above

Examples:

Conversation:
user: Main Neha hoon, Module 1 abhi start kiya hai. Arrays theek hain but sorting samajh nahi aa rahi
user: aur please real-life analogies se samjhao
Output:
{"facts": [
  {"text": "User's name is Neha", "category": "identity"},
  {"text": "User has just started Module 1", "category": "progress"},
  {"text": "User struggles with sorting", "category": "weak_topic"},
  {"text": "User prefers explanations with real-life analogies", "category": "preference"}
]}

Conversation:
user: hello!
assistant: Hi! How can I help you today?
user: kuch nahi, bas aise hi. thanks
Output:
{"facts": []}

Conversation:
assistant: What is your main target for this course?
user: internship by December
Output:
{"facts": [
  {"text": "User wants to get an internship by December", "category": "goal"}
]}`;
