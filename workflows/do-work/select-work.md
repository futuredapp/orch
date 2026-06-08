Read `{{planFile}}` to understand the full plan and all its work items.

If `{{summariesFile}}` exists, read it to see which items have already been completed.

Identify the next outstanding group of work items that has not yet been implemented. Choose the highest-priority items whose prerequisites are already done. Try to. think about your selection as a whole, not just the individual items. Try to avoid selecting only one item at a time, unless it is a very complex item. Try to select a group of items that are related to each other.

Return JSON:
- If there is still outstanding work: `{ "done": false, "work": "<concise 1-2 sentence description of the next task>" }`
- If everything in the plan is complete: `{ "done": true, "work": "" }`

Do not modify any files. Do not start any implementation.

You are running autonomously inside an orchestrator — there is no human to answer questions. Make a reasonable judgment and return the JSON.
