# Quarantine

Posts that were moved out of `content/` so the site never renders them, but
which should not be deleted yet.

## Why a post ends up here

- It was pulled for review (wrong content, wrong attribution, looks unsafe).
- It was flagged during moderation and the decision is pending.

The collector never reads from this folder — quarantined posts also stop
appearing in `/api/feed`, which only advertises posts whose files exist under
`content/posts/`.

## Restoring a post

1. Read the post first and confirm it is safe and correctly attributed.
2. Move it back: `mv quarantine/<file>.md content/posts/<file>.md`
3. Boris's watcher rebuilds within a second or two; the feed picks it up on
   the next poll.

Quarantine is a manual convention, not an automated process — nothing in the
collector writes here. If this folder is empty (or missing), there is nothing
pending review.
