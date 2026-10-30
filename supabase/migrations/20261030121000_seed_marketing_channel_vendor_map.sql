-- Seed the Channel Summary vendor map from the FY25-26 Marketing ROI tracker workbook,
-- matched to live Xero contact ids (via the edge function's discover mode). 34 vendors.
-- New vendors on the ad accounts (302/475) surface as "Uncategorized" until added here;
-- vendors on the SHARED accounts (332 Software, 411 Printing, 377 WrkPod Staff) must be
-- added here to count at all (those accounts also hold non-marketing spend).
insert into public.marketing_channel_vendor_map (contact_id, vendor, type, platform) values
-- Digital Ads (platform set)
('20732f2e-e12b-4f5d-9dfb-1bde837145aa','Google','Digital Ads','Google'),
('5ea7b8c8-f858-413d-94c7-a70319948f64','Microsoft Ads','Digital Ads','Bing'),
('e8d19c5d-28e7-4e61-861b-502a1406636c','Microsoft','Digital Ads','Bing'),
('5f99efe7-ea6e-46e5-8924-fa4e9ac2c86e','Linkedin Sales Navigator','Digital Ads','LinkedIn'),
('17518001-33e5-4d42-a45a-d6f84e52bf41','Facebook','Digital Ads','Meta'),
-- Agency (3 also carry a Website platform)
('fc88729b-8b63-4590-8d18-4c61eb2bea94','Simple Digital','Agency',null),
('2af0de1b-a429-4b69-ab7b-11fe83fed47a','NEMO MEDIA GROUP','Agency',null),
('0366d20d-cfc0-4100-b06f-f99f037ac6a9','mel Hird Photography','Agency',null),
('a9b8676d-57e8-4fa9-bb2b-d04ee4341ec9','Mick Cutcliffe','Agency',null),
('4b64620d-a522-476b-822f-9607c04dba2b','SKYLEAD','Agency',null),
('dc4337c5-5c05-46dc-99ca-63daac44e4a3','DONE DIGITAL','Agency','Website'),
('925c6252-0531-43ad-b808-6771b6663cae','sites at scale','Agency','Website'),
('c31775ce-fcb0-49d8-9ed7-4ff3d6ff78e3','WP MEDIA LYON','Agency','Website'),
('179cfe05-a8ac-4ac6-adf6-2d535d5ce141','WONDERY','Agency',null),
-- Wages (marketing VAs only — NOT the whole WrkPod Staff account)
('9c951e9c-89fc-48a3-8de2-f950115ae013','Jaycel Joy Java','Wages',null),
('776ef7d5-5cf7-436a-9640-cabded48391b','Relben Tantio','Wages',null),
('ef59340e-ccd7-442d-8492-bb4a9a713894','Liv Junne Badon','Wages',null),
('75c04785-cb8b-4744-8eb7-b04e90cbdd29','Liv Badon','Wages',null),
('92034259-9b31-44f3-9edc-1948c12f6192','Nicki Ann Venezuela','Wages',null),
('51c397fd-7e77-43c3-9cf5-96af2e51b2e9','Nicki Ann N Venezuela','Wages',null),
('e5d520b1-c7b5-41cd-b199-f13f1e9f3088','Sharmaine Cuevas','Wages',null),
('876017a2-f15f-4e32-b666-9eb1fc0b4645','KFM','Wages',null),
-- Software (marketing software only)
('7333bade-059c-42e2-a0cc-758371184a98','ACTIVECAMPAIGN','Software',null),
('d87acab8-023a-4e24-b201-0f3ff6bd9e97','OPUS','Software',null),
('ba9c00cc-e2f0-4b11-ae2c-5ed3d4176730','OPUS CLIP','Software',null),
('af8e9408-f965-4e2e-a1df-8aeed6adf77e','Vimeo','Software',null),
-- Tools
('a08d0772-cc8e-4e7a-802f-c78e8ff20ab8','IT GENIUS','Tools',null),
('5d8ff214-87be-4566-8ed0-04c0fefa3889','LATER.COM','Tools',null),
('2c7a4027-0bd3-4917-ac1d-bc265269ca35','WISESTAMP.COM','Tools',null),
('a010cba4-e729-4751-ab4a-6a341e686e1c','QR-CODE-GENERATOR.COM','Tools',null),
-- Printed Collaterals
('ba3dd5bb-3896-44bb-8377-ee4c91363e1e','SNAP GORDON','Printed Collaterals',null),
('ba53180f-c3b6-4a1b-a813-251a788be8be','vistaprint','Printed Collaterals',null),
('ad19bc17-bed7-4d5a-9e12-543833b7ecf5','SNAPFISH AU','Printed Collaterals',null),
('386131f3-01aa-4ca0-84e4-d5ad1177b98c','SNAP PRINTING','Printed Collaterals',null)
on conflict (contact_id) do update set vendor=excluded.vendor, type=excluded.type, platform=excluded.platform, updated_at=now();
