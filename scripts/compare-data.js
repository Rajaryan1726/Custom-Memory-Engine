// Data for the provider-neutral engine-vs-Mem0 comparison (scripts/eval-mem0-compare.js).
//
// UPDATE_SCENARIOS: the 16 update scenarios of scripts/eval-update.js, ported to the neutral
// interface (add / getAll / search / deleteAll only). Each check has a plain-English expected
// final state that the neutral judge compares with the final memory list.
// Steps:  { say: text | messages[], as? }   one add() (as = user key, default "a")
//         { parallel: [text, text] }         two add() calls at the same time for user "a"
//         { deleteAll: userKey }
// Checks: { as, expected }                   judge getAll of that user
//         { search: { as, query, limit }, expected }   judge the search results (rank order)
//         users written "1:a" belong to another scenario (scenario 13 reuses scenario 1).
//
// Three scenarios test engine-only APIs and are adapted to what a caller can observe:
//   1  sessionId metadata, createdAt and history() are not in the neutral interface -> final state only.
//   15 restore() is not in the interface -> the user-facing equivalent: DP weak, clear, then weak again.
//   16 delete(id) is not in the interface -> deleteAll() must leave nothing behind.
//   6  the archive checks (archivedReason, archivedAt) -> final state only.

export const UPDATE_SCENARIOS = [
  {
    id: '1',
    name: 'Module 2, then Module 3',
    steps: [{ say: 'Main abhi Module 2 pe hoon' }, { say: 'Ab main Module 3 pe aa gaya hoon' }],
    checks: [{ as: 'a', expected: 'The current module is Module 3. No memory says the student is currently on Module 2. The current module is not stored twice.' }],
  },
  {
    id: '2',
    name: 'Module 3 khatam, then Module 4 shuru',
    steps: [{ say: 'Maine Module 3 khatam kar liya' }, { say: 'Aaj se Module 4 shuru kiya' }],
    checks: [{ as: 'a', expected: 'The student is currently on Module 4. No memory says the student is currently on, or still doing, Module 3 (saying Module 3 is completed is fine).' }],
  },
  {
    id: '3',
    name: 'Module 5 + linked lists, then trees',
    steps: [{ say: 'Main Module 5 pe hoon, abhi linked lists kar raha hoon' }, { say: 'ab trees start kiya' }],
    checks: [{ as: 'a', expected: 'The student is on Module 5 and is currently studying trees. No memory says the student is currently studying linked lists.' }],
  },
  {
    id: '4',
    name: 'Same conversation added twice',
    steps: [
      { say: [
        { role: 'user', content: 'Hi, main Raj hoon. Main Module 2 pe hoon aur recursion mein dikkat hai' },
        { role: 'assistant', content: 'Chalo shuru karte hain' },
        { role: 'user', content: 'mujhe code examples se jaldi samajh aata hai' },
      ] },
      { say: [
        { role: 'user', content: 'Hi, main Raj hoon. Main Module 2 pe hoon aur recursion mein dikkat hai' },
        { role: 'assistant', content: 'Chalo shuru karte hain' },
        { role: 'user', content: 'mujhe code examples se jaldi samajh aata hai' },
      ] },
    ],
    checks: [{ as: 'a', expected: 'The memories say: the name is Raj, the student is on Module 2, the student has difficulty with recursion, and the student learns faster from code examples. None of these facts is stored more than once.' }],
  },
  {
    id: '5',
    name: 'recursion twice in different words',
    steps: [{ say: 'mujhe recursion samajh nahi aata' }, { say: 'recursion mein abhi bhi dikkat hai' }],
    checks: [{ as: 'a', expected: 'Exactly one memory says the student has difficulty with recursion. The difficulty is not stored twice.' }],
  },
  {
    id: '6',
    name: 'DP weak, then DP clear',
    steps: [{ say: 'DP mein bahut dikkat hai' }, { say: 'ab DP clear ho gaya' }],
    checks: [{ as: 'a', expected: 'No memory says the student currently struggles with DP (dynamic programming). A memory saying DP is now clear is fine; an empty list is also fine.' }],
  },
  {
    id: '7',
    name: 'Ended fact with nothing stored',
    steps: [{ say: 'ab mujhe sorting aa gayi' }],
    checks: [{ as: 'a', expected: 'No memory says the student struggles with sorting. An empty list is fine; a memory saying the student now understands sorting is also fine.' }],
  },
  {
    id: '8',
    name: 'recursion, then graphs',
    steps: [{ say: 'mujhe recursion samajh nahi aata' }, { say: 'graphs bhi samajh nahi aate' }],
    checks: [{ as: 'a', expected: 'Two difficulties are remembered: recursion and graphs. The graphs difficulty did not replace the recursion one.' }],
  },
  {
    id: '9a',
    name: 'short explanations, then one-off "isko detail mein samjhao"',
    steps: [{ say: 'mujhe short explanations chahiye' }, { say: 'isko detail mein samjhao' }],
    checks: [{ as: 'a', expected: 'A memory says the student prefers short explanations. No memory says the student prefers detailed explanations as a lasting preference (the second message was a one-off request for one answer).' }],
  },
  {
    id: '9b',
    name: 'short explanations, then standing "hamesha detail mein samjhaya karo"',
    steps: [{ say: 'mujhe short explanations chahiye' }, { say: 'short se samajh nahi aata, hamesha detail mein samjhaya karo' }],
    checks: [{ as: 'a', expected: 'The lasting preference is now detailed explanations. No memory says the student currently prefers short explanations.' }],
  },
  {
    id: '10',
    name: 'placement goal, then Amazon SDE goal',
    steps: [{ say: 'placement ke liye DSA strong karna hai' }, { say: 'Amazon SDE ke liye DSA strong karna hai' }],
    checks: [{ as: 'a', expected: 'A goal memory says the student wants to make DSA strong for an Amazon SDE role. The DSA goal is not stored as two separate goals.' }],
  },
  {
    id: '11',
    name: 'Long mixed sequence, name survives',
    steps: [
      { say: 'Hi, main Kabir hoon' },
      { say: 'Main abhi Module 2 pe hoon' },
      { say: 'DP mein bahut dikkat hai' },
      { say: 'graphs bhi samajh nahi aate' },
      { say: 'Ab main Module 3 pe aa gaya hoon' },
      { say: 'ab DP clear ho gaya' },
    ],
    checks: [{ as: 'a', expected: 'The name Kabir is remembered. The current module is Module 3 and no memory says the student is currently on Module 2. No memory says the student currently struggles with DP. A memory says the student struggles with graphs.' }],
  },
  {
    id: '12',
    name: 'Two students, A clears DP, B untouched',
    steps: [
      { as: 'a', say: 'DP mein bahut dikkat hai' },
      { as: 'b', say: 'DP mein bahut dikkat hai' },
      { as: 'a', say: 'ab DP clear ho gaya' },
    ],
    checks: [
      { as: 'b', expected: 'A memory says this student struggles with DP (dynamic programming).' },
      { as: 'a', expected: 'No memory says this student currently struggles with DP (dynamic programming).' },
    ],
  },
  {
    id: '13',
    name: 'After scenario 1, search "main kaunse module pe hoon?"',
    steps: [],
    checks: [{
      search: { as: '1:a', query: 'main kaunse module pe hoon?', limit: 3 },
      expected: 'The first result says the student is currently on Module 3.',
    }],
  },
  {
    id: '15',
    name: '(adapted) DP weak, then clear, then weak again',
    steps: [{ say: 'DP mein bahut dikkat hai' }, { say: 'ab DP clear ho gaya' }, { say: 'DP mein phir se dikkat aa rahi hai' }],
    checks: [{ as: 'a', expected: 'A memory says the student currently struggles with DP again. No memory says DP is currently clear or no longer a problem. The DP difficulty is not stored twice.' }],
  },
  {
    id: '16',
    name: '(adapted) deleteAll removes everything',
    steps: [{ say: 'DP mein bahut dikkat hai' }, { say: 'ab DP clear ho gaya' }, { deleteAll: 'a' }],
    checks: [{ as: 'a', expected: 'There are no memories at all.' }],
  },
  {
    id: '14',
    extra: true,
    name: '(extra) Two parallel add() calls, same user, same fact',
    steps: [{ parallel: ['mujhe backtracking samajh nahi aata', 'mujhe backtracking samajh nahi aata'] }],
    checks: [{ as: 'a', expected: 'Exactly one memory says the student has difficulty with backtracking. It is not stored twice.' }],
  },
];

// Plain-English claims for the "ended" expectations and forbidden facts of the extraction
// cases, keyed by case name. A memory counts against a provider if the judge says it
// asserts the claim as currently true. Two forbidden specs are pure category rules
// (English filed as a course weak_topic instead of "other"); a category-free harness cannot
// see that, so they are listed as skipped instead of scored.
export const CASE_CLAIMS = {
  time_change_module: { forbidden: ['The student is currently on Module 2.'] },
  time_change_goal: { forbidden: ["The student's current goal is web development."] },
  negation_resolved_weakness: {
    ended: ['The student currently struggles with DP (dynamic programming).'],
    forbidden: ['The student currently struggles with DP (dynamic programming).'],
  },
  other_person_friend_weak: { forbidden: ['The student (not a friend) is weak at graphs.'] },
  other_person_sister_vs_self: {
    forbidden: ['The student (not the sister) is on Module 7.', 'The student (not the sister) likes DP.'],
  },
  hypothetical_module: { forbidden: ['The student is on Module 5.'] },
  sarcasm_recursion_easy: { forbidden: ['The student finds recursion easy.'] },
  joke_virat_kohli: { forbidden: ['The student is (like) Virat Kohli, i.e. a star or expert at coding.'] },
  language_vs_topic_hindi_request: { skipped: ['category-only rule: English as a course weak_topic'] },
  language_vs_topic_both: { skipped: ['category-only rule: English as a course weak_topic'] },
  one_off_request_not_a_fact: { forbidden: ['The student has a lasting preference for dry runs of solutions.'] },
  one_off_request_english: { forbidden: ['The student has a lasting preference for slower explanations.'] },
  one_off_request_hinglish_2: { forbidden: ['The student has a lasting preference for explanations in smaller steps.'] },
};

export const SEARCH_LATENCY_QUERY = 'student ke baare mein kya pata hai: naam, module, weak topics, preferences?';
