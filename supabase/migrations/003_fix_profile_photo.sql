-- SiblingTab fix: saving a profile photo failed with "permission denied for table profiles".
-- The app saves your photo with an upsert, which also needs permission on the id column.
-- The row-level security policy still only lets you touch your own row.
-- (Already included in 002 for new databases; safe to run more than once.)
grant update (id, avatar_path, updated_at) on public.profiles to authenticated;
