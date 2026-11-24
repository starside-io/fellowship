-- AlterTable
ALTER TABLE "Person" ADD COLUMN "mbti" TEXT;

-- AlterTable
ALTER TABLE "PersonProfile" ADD COLUMN "personality" JSONB;
ALTER TABLE "PersonProfile" ADD COLUMN "personalityAt" DATETIME;

-- The palette moves to the brand four (charcoal, sand, coral, crimson). The
-- old twelve map to the new twelve by index, which is how avatarColorFor picks
-- one, so a stored colour lands where a fresh pick for the same name would.
-- A colour someone chose by hand that is not one of the twelve is left alone.
UPDATE "Person"
SET "avatarColor" = CASE lower("avatarColor")
  WHEN '#ef4444' THEN '#b3162f'
  WHEN '#f97316' THEN '#dc7465'
  WHEN '#f59e0b' THEN '#c8955a'
  WHEN '#10b981' THEN '#6f9a7e'
  WHEN '#14b8a6' THEN '#4f8f8b'
  WHEN '#0ea5e9' THEN '#5b82a6'
  WHEN '#6366f1' THEN '#5f6aa0'
  WHEN '#8b5cf6' THEN '#8a6a9e'
  WHEN '#d946ef' THEN '#a8617f'
  WHEN '#ec4899' THEN '#d0828f'
  WHEN '#64748b' THEN '#6b6d75'
  WHEN '#84cc16' THEN '#8d9a52'
  ELSE "avatarColor"
END;

UPDATE "Circle"
SET "colour" = CASE lower("colour")
  WHEN '#ef4444' THEN '#b3162f'
  WHEN '#f97316' THEN '#dc7465'
  WHEN '#f59e0b' THEN '#c8955a'
  WHEN '#10b981' THEN '#6f9a7e'
  WHEN '#14b8a6' THEN '#4f8f8b'
  WHEN '#0ea5e9' THEN '#5b82a6'
  WHEN '#6366f1' THEN '#5f6aa0'
  WHEN '#8b5cf6' THEN '#8a6a9e'
  WHEN '#d946ef' THEN '#a8617f'
  WHEN '#ec4899' THEN '#d0828f'
  WHEN '#64748b' THEN '#6b6d75'
  WHEN '#84cc16' THEN '#8d9a52'
  ELSE "colour"
END;

-- Tags take the per kind defaults first: sage for a like, crimson for an
-- allergy, ochre for a dislike. Then any other old palette colour moves by index.
UPDATE "Tag" SET "colour" = '#6f9a7e' WHERE "kind" = 'INTEREST' AND lower("colour") = '#10b981';
UPDATE "Tag" SET "colour" = '#b3162f' WHERE "kind" = 'ALLERGY' AND lower("colour") = '#ef4444';
UPDATE "Tag" SET "colour" = '#c8955a' WHERE "kind" = 'DISLIKE' AND lower("colour") = '#64748b';
UPDATE "Tag"
SET "colour" = CASE lower("colour")
  WHEN '#ef4444' THEN '#b3162f'
  WHEN '#f97316' THEN '#dc7465'
  WHEN '#f59e0b' THEN '#c8955a'
  WHEN '#10b981' THEN '#6f9a7e'
  WHEN '#14b8a6' THEN '#4f8f8b'
  WHEN '#0ea5e9' THEN '#5b82a6'
  WHEN '#6366f1' THEN '#5f6aa0'
  WHEN '#8b5cf6' THEN '#8a6a9e'
  WHEN '#d946ef' THEN '#a8617f'
  WHEN '#ec4899' THEN '#d0828f'
  WHEN '#64748b' THEN '#6b6d75'
  WHEN '#84cc16' THEN '#8d9a52'
  ELSE "colour"
END;
