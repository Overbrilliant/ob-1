# demos/memory-graph.tape — records the REAL /memory inspector (no faked output).
#
# The workspace's .ob1/memory.db must hold GENUINE facts/relationships from real sessions.
# To build them honestly, run a session first and let the agent record project facts, e.g.:
#   ob1 → "Study this repo, then use memory_add and relate to record its key facts and how they connect."
# memory_add/relate fire during that real work; do NOT hand-craft the database.
#   export OB1_DEMO_HOME=<settings dir with a working provider>
#   export OB1_DEMO_PROJECT=<workspace whose .ob1/memory.db is populated>
#   vhs demos/memory-graph.tape
#
# Gotchas: Sleep-only timing; unset OB1_SERVER. Re-render at release for the shipped banner version.

Output docs/media/memory-graph.gif
Set Shell "bash"
Set FontSize 14
Set Width 920
Set Height 560
Set Padding 12
Set TypingSpeed 55ms

Hide
Type `export OB1_SETTINGS_DIR="$OB1_DEMO_HOME"; unset OB1_SERVER OB1_BASE_URL OB1_API_KEY; cd "$OB1_DEMO_PROJECT"; clear`
Enter
Show

Sleep 800ms
Type "ob1"
Sleep 600ms
Enter
Sleep 9s
Type "/memory"
Sleep 700ms
Enter
# facts + relationship graph + stats render from the real memory.db
Sleep 7s
