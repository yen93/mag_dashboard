-- Map HEYGEN and HIGGSFIELD INC to marketing spend type 'Software' (Account 332: Software subscriptions).
-- Discovered via Xero bank transactions:
--   - d5f90dff-f710-4f35-862d-dd29889eec80 ('HEYGEN', $196.29 on account 332)
--   - 421b36c0-612d-4388-9997-81a338a37191 ('HIGGSFIELD INC', $340.88 on account 332)
-- Adding these with include = true allows the xero-channel-summary-sync edge function
-- to retain HeyGen and Higgsfield transactions on shared account 332 and write them into public.marketing_channel_monthly.

INSERT INTO public.marketing_channel_vendor_map (contact_id, vendor, type, platform, include, updated_at)
VALUES
  ('d5f90dff-f710-4f35-862d-dd29889eec80', 'HEYGEN', 'Software', NULL, TRUE, NOW()),
  ('421b36c0-612d-4388-9997-81a338a37191', 'HIGGSFIELD INC', 'Software', NULL, TRUE, NOW())
ON CONFLICT (contact_id) DO UPDATE
  SET vendor = EXCLUDED.vendor,
      type = EXCLUDED.type,
      platform = EXCLUDED.platform,
      include = EXCLUDED.include,
      updated_at = NOW();
