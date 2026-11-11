-- Map Adobe and Adobe membership to marketing spend type 'Software' (Account 332: Software subscriptions).
-- Discovered via Xero bank transactions:
--   - 30d0112e-13e3-434c-a94e-94155847e37d ('Adobe', $3,758.88 on account 332)
--   - 54fbce61-34ee-4fc0-87fe-0a70e2898484 ('Adobe membership', $791.88 on account 332)
-- Adding these with include = true allows the xero-channel-summary-sync edge function
-- to retain Adobe transactions on shared account 332 and write them into public.marketing_channel_monthly.

INSERT INTO public.marketing_channel_vendor_map (contact_id, vendor, type, platform, include, updated_at)
VALUES
  ('30d0112e-13e3-434c-a94e-94155847e37d', 'Adobe', 'Software', NULL, TRUE, NOW()),
  ('54fbce61-34ee-4fc0-87fe-0a70e2898484', 'Adobe membership', 'Software', NULL, TRUE, NOW())
ON CONFLICT (contact_id) DO UPDATE
  SET vendor = EXCLUDED.vendor,
      type = EXCLUDED.type,
      platform = EXCLUDED.platform,
      include = EXCLUDED.include,
      updated_at = NOW();
