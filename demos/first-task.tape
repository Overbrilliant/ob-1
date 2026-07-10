# demos/first-task.tape — records the REAL agent completing a task (no faked output).
#
# Prereqs: a configured OB1_DEMO_HOME whose provider profile points at a WORKING model source
# (a FreeLLMAPI proxy with at least one live provider key, or any OpenAI-compatible endpoint).
# Anonymous-only pools can be rate-limit-exhausted; add a free provider key first if so.
#   export OB1_DEMO_HOME=<settings dir with a working provider>
#   export OB1_DEMO_PROJECT="$(mktemp -d)"; ( cd "$OB1_DEMO_PROJECT" && git init -q )
#   vhs demos/first-task.tape
# Then trim/optimize to the completion frame (see demos/README.md for the ffmpeg+gifsicle recipe).
#
# Gotchas: Sleep-only timing (Wait/Screenshot abort the recording); unset OB1_SERVER; default
# permission mode is autopilot so the agent won't stall on an approval prompt; agent latency varies
# by routed model, so the trailing Sleep is generous and the take is trimmed afterward.

Output docs/media/first-task-raw.gif
Set Shell "bash"
Set FontSize 14
Set Width 920
Set Height 560
Set Padding 12
Set TypingSpeed 45ms

Hide
Type `export OB1_SETTINGS_DIR="$OB1_DEMO_HOME"; unset OB1_SERVER OPENROUTER_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GROQ_API_KEY OB1_BASE_URL OB1_API_KEY OB1_TOKEN; cd "$OB1_DEMO_PROJECT"; clear`
Enter
Show

Sleep 800ms
Type "ob1"
Sleep 600ms
Enter
Sleep 9s
Type "Create primes.py that prints the first 10 prime numbers, then run it and show the output."
Sleep 800ms
Enter
# real agent loop: write_file → run_bash → verify → summary. Trim to the completion frame.
Sleep 90s
