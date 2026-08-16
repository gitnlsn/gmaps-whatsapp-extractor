-- Receita stores DDD and the subscriber number in separate columns, and the
-- subscriber number is in the pre-2016 eight-digit format. Repairing it needs
-- both parts, so keep them rather than only the concatenated string.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_ddd   TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_local TEXT;
