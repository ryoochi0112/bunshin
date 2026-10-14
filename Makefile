.PHONY: verify syntax test acceptance acceptance-codex
.PHONY: harness

verify: syntax test

syntax:
	@set -e; \
	for dir in bin lib scripts test; do \
	  if [ -d "$$dir" ]; then \
	    find "$$dir" -type f -name '*.js' -print | while IFS= read -r file; do \
	      node --check "$$file" || exit 1; \
	    done; \
	  fi; \
	done

test:
	node --test test/*.test.js

acceptance:
	node scripts/acceptance.js --host claude

acceptance-codex:
	node scripts/acceptance.js --host codex

harness:
	node scripts/harness.js --host claude
