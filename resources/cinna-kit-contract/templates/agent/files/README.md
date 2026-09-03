# Files

Static inputs that ship with the agent: fixtures, sample documents, templates it
fills in, a reference spreadsheet. Read-only at runtime.

Anything the agent *produces* goes to `app-data/storage/` instead — that folder is
git-ignored and never published, which is exactly right for output and exactly
wrong for input the agent needs to work.
