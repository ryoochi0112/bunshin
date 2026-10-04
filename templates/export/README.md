# {{name}} twin — persona v{{version}}

Load this directory as a plugin in a fresh Claude Code session:

```sh
claude --plugin-dir /absolute/path/to/this/package
```

No bunshin code or installation is required. Invoke `/{{name}}-twin:spec-answer` with a product question, or `/{{name}}-twin:idea-discussion` with an idea. Each skill contains the exported identity and the complete twin instructions. The plugin manifest version is the persona version written as a string.

For spec answers, connect Notion with the host's search and read tools. Every factual claim cites a current Notion page. With no reachable source, the twin says "I do not know" and ends with `Sources: none`. Idea discussions take a position and raise an objection or question tagged with an exact priority name from the identity. Replies follow the main language of the question.

The twin never posts or sends anything. Replies are private drafts for you. Keep this package private: it contains your identity and evidence links. It contains no raw messages, interview answers, evaluation results, calibration ratings or shadow drafts.
