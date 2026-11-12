// server/metrics/n8n-automations.js
// Provides live telemetry, execution history, and catalog of all active n8n workflows
// triggered via webhooks and scheduled by Supabase pg_cron.
// 1 webhook corresponds to 1 discrete automation.

import { config } from '../config.js';

// Canonical catalog of all active n8n webhook automations triggered by Supabase pg_cron.
export const N8N_AUTOMATIONS_CATALOG = [
  // --- Insta Story Scraper (Workflow: R6VdvISsfVnq39Tr) ---
  {
    id: 'n8n-insta-story-scraper',
    name: 'Instagram Stories Scraper Pipeline',
    slug: 'n8n-insta-story-scraper',
    workflowName: 'Insta Story Scraper',
    workflowId: 'R6VdvISsfVnq39Tr',
    webhookNodeName: 'Webhook',
    webhookPath: 'c2fa45b3-49b1-496b-9dd0-8193897caa2f',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/c2fa45b3-49b1-496b-9dd0-8193897caa2f',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'n8n-insta-story-scraper',
    cronExpression: '0 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:00 AM Manila (22:00 UTC)',
    scheduleDesc: 'Monday through Friday at 6:00 AM Manila (cron: 0 22 * * 0-4)',
    description: 'Triggers Instagram story scraping pipeline via Apify Actor, parses creator profiles and story media, and stores raw story data into Supabase Postgres for engagement analysis.',
    connectors: ['Supabase Postgres', 'Apify Actor', 'n8n Webhook'],
    targetTables: ['public.insta_stories'],
    downstreamNodesCount: 19
  },
  {
    id: 'insta-story-scraper-log-to-sheet-and-notify-liv',
    name: 'Instagram Stories Sheet Sync & Notification',
    slug: 'insta-story-scraper-log-to-sheet-and-notify-liv',
    workflowName: 'Insta Story Scraper',
    workflowId: 'R6VdvISsfVnq39Tr',
    webhookNodeName: 'Webhook1',
    webhookPath: '57fe4813-a476-4f26-b27b-e011e5c17092',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/57fe4813-a476-4f26-b27b-e011e5c17092',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'Insta Story Scraper: Log to sheet and notify Liv',
    cronExpression: '0 23 * * 0-4',
    cronHuman: 'Mon–Fri 7:00 AM Manila (23:00 UTC)',
    scheduleDesc: 'Monday through Friday at 7:00 AM Manila (cron: 0 23 * * 0-4)',
    description: 'Extracts newly processed Instagram story mentions from Postgres, syncs records to Google Sheets, and sends daily digest notification email via Gmail.',
    connectors: ['Supabase Postgres', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.insta_stories'],
    downstreamNodesCount: 5
  },

  // --- Sales Batch Mailer V2 (Workflow: cMQvsiTLhNoHK1Fm) ---
  {
    id: 'n8n-batch-mailer-ai-scraped-soc-med-leads',
    name: 'Batch Mailer — AI Scraped Social Media Leads',
    slug: 'n8n-batch-mailer-ai-scraped-soc-med-leads',
    workflowName: 'Sales Batch Mailer V2',
    workflowId: 'cMQvsiTLhNoHK1Fm',
    webhookNodeName: 'Webhook',
    webhookPath: '86d26274-f8f8-4abf-9457-e144c42d5ee1',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/86d26274-f8f8-4abf-9457-e144c42d5ee1',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-batch-mailer-ai-scraped-soc-med-leads',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Processes AI-discovered social media prospect leads from Google Sheets, matches deal context, prepares tailored sales outreach copy, and creates drafts in Gmail.',
    connectors: ['Supabase Postgres', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.sales_outreach_leads'],
    downstreamNodesCount: 69
  },
  {
    id: 'n8n-batch-mailer-manually-found-leads',
    name: 'Batch Mailer — Manually Identified Leads',
    slug: 'n8n-batch-mailer-manually-found-leads',
    workflowName: 'Sales Batch Mailer V2',
    workflowId: 'cMQvsiTLhNoHK1Fm',
    webhookNodeName: 'Webhook1',
    webhookPath: '49bc9abe-eaed-49ec-b749-8e051090896c',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/49bc9abe-eaed-49ec-b749-8e051090896c',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-batch-mailer-manually-found-leads',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Processes manually identified conference & speaking prospect rows from Google Sheet, verifies email deliverability, and queues personalized sales outreach drafts in Gmail.',
    connectors: ['Supabase Postgres', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.sales_outreach_leads'],
    downstreamNodesCount: 66
  },
  {
    id: 'n8n-batch-mailer-ai-soc-med-alternate-leads',
    name: 'Batch Mailer — AI Social Media Alternate Leads',
    slug: 'n8n-batch-mailer-ai-soc-med-alternate-leads',
    workflowName: 'Sales Batch Mailer V2',
    workflowId: 'cMQvsiTLhNoHK1Fm',
    webhookNodeName: 'Webhook2',
    webhookPath: 'b17ac35b-0235-484b-be50-c3783ac77a8c',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/b17ac35b-0235-484b-be50-c3783ac77a8c',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-batch-mailer-ai-soc-med-alternate-leads',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Engages secondary and alternate organizational decision makers sourced via social media intelligence when primary contact is unresponsive.',
    connectors: ['Supabase Postgres', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.sales_outreach_leads'],
    downstreamNodesCount: 70
  },
  {
    id: 'n8n-batch-mailer-alternate-cold-leads',
    name: 'Batch Mailer — Alternate Cold Leads',
    slug: 'n8n-batch-mailer-alternate-cold-leads',
    workflowName: 'Sales Batch Mailer V2',
    workflowId: 'cMQvsiTLhNoHK1Fm',
    webhookNodeName: 'Webhook3',
    webhookPath: 'e64817f4-c359-4bc2-a40f-ca9e23b92fe7',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/e64817f4-c359-4bc2-a40f-ca9e23b92fe7',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-batch-mailer-alternate-cold-leads',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Batches cold email sequence outreach for alternate contacts within targeted corporate enterprise accounts, generating Gmail drafts with contextual copy.',
    connectors: ['Supabase Postgres', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.sales_outreach_leads'],
    downstreamNodesCount: 66
  },
  {
    id: 'n8n-batch-mailer-ai-scraped-cold-leads',
    name: 'Batch Mailer — AI Scraped Cold Leads',
    slug: 'n8n-batch-mailer-ai-scraped-cold-leads',
    workflowName: 'Sales Batch Mailer V2',
    workflowId: 'cMQvsiTLhNoHK1Fm',
    webhookNodeName: 'Webhook4',
    webhookPath: 'd363d508-d222-4783-acef-35efa48240b7',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/d363d508-d222-4783-acef-35efa48240b7',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-batch-mailer-ai-scraped-cold-leads',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Batches outbound sales sequences for primary cold prospect leads discovered via automated scraping tools, tracking status in Google Sheets and Postgres.',
    connectors: ['Supabase Postgres', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.sales_outreach_leads'],
    downstreamNodesCount: 65
  },

  // --- AC Notes Automation (Workflow: 8vZG1SAYwSmcHJ2x) ---
  {
    id: 'n8n-ac-notes-intro',
    name: 'AC Notes — Sequence Intro Touchpoint',
    slug: 'n8n-ac-notes-intro',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook',
    webhookPath: '3c2a741d-656f-41fe-846e-a84d4b0ae530',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/3c2a741d-656f-41fe-846e-a84d4b0ae530',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-ac-notes-intro',
    cronExpression: '40 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:40 AM Manila (22:40 UTC)',
    scheduleDesc: 'Monday through Friday at 6:40 AM Manila (cron: 40 22 * * 0-4)',
    description: 'Extracts introductory sequence email thread metadata and writes activity summary notes onto matching ActiveCampaign contact cards via AC REST API.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-ac-notes-1st-followup',
    name: 'AC Notes — 1st Follow-up Touchpoint',
    slug: 'n8n-ac-notes-1st-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook1',
    webhookPath: '968fa7b5-c233-4488-b09a-8b57975dd512',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/968fa7b5-c233-4488-b09a-8b57975dd512',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-ac-notes-1st-followup',
    cronExpression: '45 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:45 AM Manila (22:45 UTC)',
    scheduleDesc: 'Monday through Friday at 6:45 AM Manila (cron: 45 22 * * 0-4)',
    description: 'Tracks 1st follow-up touchpoint engagement, logs timestamped sequence progression notes, and updates contact records in ActiveCampaign.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-ac-notes-2nd-followup',
    name: 'AC Notes — 2nd Follow-up Touchpoint',
    slug: 'n8n-ac-notes-2nd-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook2',
    webhookPath: 'f8e3664b-0c56-479e-8702-e4bfa6a8aeba',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/f8e3664b-0c56-479e-8702-e4bfa6a8aeba',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-ac-notes-2nd-followup',
    cronExpression: '50 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:50 AM Manila (22:50 UTC)',
    scheduleDesc: 'Monday through Friday at 6:50 AM Manila (cron: 50 22 * * 0-4)',
    description: 'Tracks 2nd follow-up touchpoint delivery and logs structured communication logs in ActiveCampaign contact timelines.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-ac-notes-3rd-followup',
    name: 'AC Notes — 3rd Follow-up Touchpoint',
    slug: 'n8n-ac-notes-3rd-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook3',
    webhookPath: '2a30ffcf-4f94-44f4-9a83-59ec3b18abf4',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/2a30ffcf-4f94-44f4-9a83-59ec3b18abf4',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-ac-notes-3rd-followup',
    cronExpression: '55 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:55 AM Manila (22:55 UTC)',
    scheduleDesc: 'Monday through Friday at 6:55 AM Manila (cron: 55 22 * * 0-4)',
    description: 'Logs 3rd sequence follow-up status, updates engagement tracking metadata, and flags prospects nearing sequence completion.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-cold-leads-notes-intro',
    name: 'AC Notes — Cold Outbound Intro Touchpoint',
    slug: 'n8n-cold-leads-notes-intro',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook4',
    webhookPath: '2dcf9990-d794-43c7-9fb4-b81f1caad619',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/2dcf9990-d794-43c7-9fb4-b81f1caad619',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-cold-leads-notes-intro',
    cronExpression: '40 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:40 AM Manila (22:40 UTC)',
    scheduleDesc: 'Monday through Friday at 6:40 AM Manila (cron: 40 22 * * 0-4)',
    description: 'Creates activity notes in ActiveCampaign for cold outbound prospect intro emails sent via automated mailer pipeline.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-cold-leads-notes-1st-followup',
    name: 'AC Notes — Cold Outbound 1st Follow-up',
    slug: 'n8n-cold-leads-notes-1st-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook5',
    webhookPath: 'd1ab03b4-fb68-460f-8a4a-24f057c59480',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/d1ab03b4-fb68-460f-8a4a-24f057c59480',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-cold-leads-notes-1st-followup',
    cronExpression: '45 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:45 AM Manila (22:45 UTC)',
    scheduleDesc: 'Monday through Friday at 6:45 AM Manila (cron: 45 22 * * 0-4)',
    description: 'Syncs 1st cold outreach follow-up notes and timestamp indicators into ActiveCampaign.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-cold-leads-notes-2nd-followup',
    name: 'AC Notes — Cold Outbound 2nd Follow-up',
    slug: 'n8n-cold-leads-notes-2nd-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook6',
    webhookPath: '358613aa-1325-40e8-b2b2-af3ec223d579',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/358613aa-1325-40e8-b2b2-af3ec223d579',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-cold-leads-notes-2nd-followup',
    cronExpression: '50 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:50 AM Manila (22:50 UTC)',
    scheduleDesc: 'Monday through Friday at 6:50 AM Manila (cron: 50 22 * * 0-4)',
    description: 'Syncs 2nd cold outreach follow-up progress notes and timestamps into ActiveCampaign contact timeline.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-cold-leads-notes-3rd-followup',
    name: 'AC Notes — Cold Outbound 3rd Follow-up',
    slug: 'n8n-cold-leads-notes-3rd-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook7',
    webhookPath: 'be7e4d56-a267-4f41-8616-c5e1be9fdab9',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/be7e4d56-a267-4f41-8616-c5e1be9fdab9',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-cold-leads-notes-3rd-followup',
    cronExpression: '55 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:55 AM Manila (22:55 UTC)',
    scheduleDesc: 'Monday through Friday at 6:55 AM Manila (cron: 55 22 * * 0-4)',
    description: 'Syncs 3rd cold outreach follow-up notes into ActiveCampaign to provide sales visibility into sequence depth.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },
  {
    id: 'n8n-cold-leads-notes-4th-followup',
    name: 'AC Notes — Cold Outbound 4th Follow-up (Final)',
    slug: 'n8n-cold-leads-notes-4th-followup',
    workflowName: 'AC Notes Automation (Follow up sequence)',
    workflowId: '8vZG1SAYwSmcHJ2x',
    webhookNodeName: 'Webhook8',
    webhookPath: '2b234727-e9ac-4f3c-ab32-f010c257bed4',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/2b234727-e9ac-4f3c-ab32-f010c257bed4',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-cold-leads-notes-4th-followup',
    cronExpression: '0 23 * * 0-4',
    cronHuman: 'Mon–Fri 7:00 AM Manila (23:00 UTC)',
    scheduleDesc: 'Monday through Friday at 7:00 AM Manila (cron: 0 23 * * 0-4)',
    description: 'Logs final 4th follow-up sequence touchpoint and marks cold outbound thread complete in ActiveCampaign.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 12
  },

  // --- Cold Leads Follow Up Sequence (Workflow: JZkIKy3LsaLx0q5z) ---
  {
    id: 'n8n-cold-leads-follow-up',
    name: 'Cold Leads Multi-Stage Follow-up Engine',
    slug: 'n8n-cold-leads-follow-up',
    workflowName: 'Cold Leads Follow Up Sequence',
    workflowId: 'JZkIKy3LsaLx0q5z',
    webhookNodeName: 'Webhook',
    webhookPath: 'cf04a824-5636-40ec-b75c-bb5d5ff6743c',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/cf04a824-5636-40ec-b75c-bb5d5ff6743c',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-cold-leads-follow-up',
    cronExpression: '25 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:25 AM Manila (22:25 UTC)',
    scheduleDesc: 'Monday through Friday at 6:25 AM Manila (cron: 25 22 * * 0-4)',
    description: 'Orchestrates multi-stage cold outbound email follow-ups. Reads active sequence threads, checks for recipient replies, generates Gmail draft responses, and updates progression states.',
    connectors: ['Supabase Postgres', 'Gmail API'],
    targetTables: ['public.follow_up_sequence_threads'],
    downstreamNodesCount: 123
  },

  // --- Cold Leads Scraper (Workflow: ww6XNc05nJlf54Vb) ---
  {
    id: 'n8n-cold-leads-scraper',
    name: 'Cold Leads Automated Scraper',
    slug: 'n8n-cold-leads-scraper',
    workflowName: 'Cold Leads Scraper',
    workflowId: 'ww6XNc05nJlf54Vb',
    webhookNodeName: 'Webhook',
    webhookPath: 'f5ca40e6-06cf-42a0-a829-0a938c03bebc',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/f5ca40e6-06cf-42a0-a829-0a938c03bebc',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'n8n-cold-leads-scraper',
    cronExpression: '35 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:35 AM Manila (22:35 UTC)',
    scheduleDesc: 'Monday through Friday at 6:35 AM Manila (cron: 35 22 * * 0-4)',
    description: 'Executes scheduled prospecting queries across web directories and search actors, extracting new organization domain leads and queuing them for qualification.',
    connectors: ['Supabase Postgres', 'Apify Actor', 'Google Sheets'],
    targetTables: ['public.scraped_leads'],
    downstreamNodesCount: 15
  },

  // --- LinkedIn Outbound Sales (Workflow: d5NAgNp9XRLFIM0R) ---
  {
    id: 'n8n-linkedin-outbound-sales',
    name: 'LinkedIn Outbound Sales & Proposal Generator',
    slug: 'n8n-linkedin-outbound-sales',
    workflowName: 'LinkedIn Outbound Sales Automations',
    workflowId: 'd5NAgNp9XRLFIM0R',
    webhookNodeName: 'Webhook',
    webhookPath: '50798cda-7448-45bf-9168-d887756fb8c8',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/50798cda-7448-45bf-9168-d887756fb8c8',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-linkedin-outbound-sales',
    cronExpression: '15 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:15 AM Manila (22:15 UTC)',
    scheduleDesc: 'Monday through Friday at 6:15 AM Manila (cron: 15 22 * * 0-4)',
    description: 'Automates qualified LinkedIn outbound prospects. Dynamically creates Google Docs speaker proposals and brief decks, matching deal parameters in Supabase Postgres.',
    connectors: ['Supabase Postgres', 'Google Docs API'],
    targetTables: ['public.linkedin_leads', 'public.activecampaign_deals'],
    downstreamNodesCount: 75
  },

  // --- LinkedIn Comments Scraping (Workflow: YAexztVMLu7zp3TN) ---
  {
    id: 'n8n-get-linkedin-posts-to-be-processed',
    name: 'LinkedIn Comments — Post Queue Loader',
    slug: 'n8n-get-linkedin-posts-to-be-processed',
    workflowName: 'LinkedIn Comments Scraping POC Enrichment',
    workflowId: 'YAexztVMLu7zp3TN',
    webhookNodeName: 'Webhook',
    webhookPath: 'e7e0b196-e1a4-4340-8af7-c6eb93509e46',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/e7e0b196-e1a4-4340-8af7-c6eb93509e46',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'n8n-get-linkedin-posts-to-be-processed',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Pulls target LinkedIn posts queued for audience scraping, executing Apify comment scraper actors to extract audience comment authors.',
    connectors: ['Supabase Postgres', 'Apify Actor'],
    targetTables: ['public.linkedin_posts'],
    downstreamNodesCount: 14
  },
  {
    id: 'n8n-find-org-of-commentor',
    name: 'LinkedIn Comments — Organization Finder',
    slug: 'n8n-find-org-of-commentor',
    workflowName: 'LinkedIn Comments Scraping POC Enrichment',
    workflowId: 'YAexztVMLu7zp3TN',
    webhookNodeName: 'Webhook1',
    webhookPath: 'd13096b0-03af-400a-8f4c-1b37cdaf8a9b',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/d13096b0-03af-400a-8f4c-1b37cdaf8a9b',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'n8n-find-org-of-commentor',
    cronExpression: '40 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:40 AM Manila (22:40 UTC)',
    scheduleDesc: 'Monday through Friday at 6:40 AM Manila (cron: 40 22 * * 0-4)',
    description: 'Resolves employer and company affiliation for scraped LinkedIn commenters using profile scrapers and entity matching.',
    connectors: ['Supabase Postgres', 'Apify Actor', 'Gmail API'],
    targetTables: ['public.linkedin_commenters'],
    downstreamNodesCount: 15
  },
  {
    id: 'n8n-comments-scraper-email-finder',
    name: 'LinkedIn Comments — Decision Maker Email Finder',
    slug: 'n8n-comments-scraper-email-finder',
    workflowName: 'LinkedIn Comments Scraping POC Enrichment',
    workflowId: 'YAexztVMLu7zp3TN',
    webhookNodeName: 'Webhook2',
    webhookPath: '5ed8979a-e286-4b3a-b5f8-c9003fb2d3b5',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/5ed8979a-e286-4b3a-b5f8-c9003fb2d3b5',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'n8n-comments-scraper-email-finder',
    cronExpression: '0 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:00 AM Manila (22:00 UTC)',
    scheduleDesc: 'Monday through Friday at 6:00 AM Manila (cron: 0 22 * * 0-4)',
    description: 'Queries B2B email enrichment APIs to find work email addresses for qualified LinkedIn commenters and their executive colleagues.',
    connectors: ['Supabase Postgres', 'Google Sheets'],
    targetTables: ['public.linkedin_commenters'],
    downstreamNodesCount: 7
  },
  {
    id: 'n8n-comments-scraper-log-email-to-sheet',
    name: 'LinkedIn Comments — Sheet Logger',
    slug: 'n8n-comments-scraper-log-email-to-sheet',
    workflowName: 'LinkedIn Comments Scraping POC Enrichment',
    workflowId: 'YAexztVMLu7zp3TN',
    webhookNodeName: 'Webhook3',
    webhookPath: '74242e51-395e-4086-a157-7a3977f31b58',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/74242e51-395e-4086-a157-7a3977f31b58',
    httpMethod: 'GET',
    category: 'Marketing',
    active: true,
    cronJobName: 'n8n-comments-scraper-log-email-to-sheet',
    cronExpression: '30 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:30 AM Manila (22:30 UTC)',
    scheduleDesc: 'Monday through Friday at 6:30 AM Manila (cron: 30 22 * * 0-4)',
    description: 'Appends newly verified prospect contact records, corporate domains, and engagement origin into master Google Sheets.',
    connectors: ['Supabase Postgres', 'Google Sheets'],
    targetTables: ['public.linkedin_commenters'],
    downstreamNodesCount: 6
  },

  // --- LinkedIn Company Lead Finder (Workflow: HvLDCK6pfxYOgCWw) ---
  {
    id: 'n8n-linkedin-company-lead-finder',
    name: 'LinkedIn Corporate Lead Finder',
    slug: 'n8n-linkedin-company-lead-finder',
    workflowName: 'LinkedIn Company Lead Finder',
    workflowId: 'HvLDCK6pfxYOgCWw',
    webhookNodeName: 'Webhook',
    webhookPath: 'e70fe2f8-2d48-4fca-8849-dbafcdff6164',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/e70fe2f8-2d48-4fca-8849-dbafcdff6164',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-linkedin-company-lead-finder',
    cronExpression: '0 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:00 AM Manila (22:00 UTC)',
    scheduleDesc: 'Monday through Friday at 6:00 AM Manila (cron: 0 22 * * 0-4)',
    description: 'Searches LinkedIn company directories for event managers, conference planners, and executive coordinators; appends qualified rows to Google Sheets.',
    connectors: ['Supabase Postgres', 'Apify Actor', 'Google Sheets', 'Gmail API'],
    targetTables: ['public.sales_liv_deals'],
    downstreamNodesCount: 21
  },

  // --- Soc Med Follow Up Sequence (Workflow: gI2MaSOvuxrzJ4m4) ---
  {
    id: 'n8n-soc-med-follow-up',
    name: 'Social Media Leads Follow-up Sequence',
    slug: 'n8n-soc-med-follow-up',
    workflowName: 'Soc Med Follow Up Sequence',
    workflowId: 'gI2MaSOvuxrzJ4m4',
    webhookNodeName: 'Webhook',
    webhookPath: 'be8d0706-4150-4358-8e0d-be4108b88615',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/be8d0706-4150-4358-8e0d-be4108b88615',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-soc-med-follow-up',
    cronExpression: '20 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:20 AM Manila (22:20 UTC)',
    scheduleDesc: 'Monday through Friday at 6:20 AM Manila (cron: 20 22 * * 0-4)',
    description: 'Monitors ongoing social media outreach email threads, detects responses, generates follow-up drafts, and updates deal stages.',
    connectors: ['Supabase Postgres', 'Gmail API'],
    targetTables: ['public.follow_up_sequence_threads'],
    downstreamNodesCount: 151
  },

  // --- Closed Threads Processing (Workflow: MveMnP6j7IIQ6UYM) ---
  {
    id: 'n8n-closed-threads-processing',
    name: 'Closed Conversation Threads Archiver',
    slug: 'n8n-closed-threads-processing',
    workflowName: 'Closed Threads Processing',
    workflowId: 'MveMnP6j7IIQ6UYM',
    webhookNodeName: 'Webhook',
    webhookPath: '8fe86e56-7c2f-45cd-9658-ab653f9f2559',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/8fe86e56-7c2f-45cd-9658-ab653f9f2559',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-closed-threads-processing',
    cronExpression: '0 22 * * 0',
    cronHuman: 'Weekly on Sunday at 6:00 AM Manila (22:00 UTC)',
    scheduleDesc: 'Weekly on Sunday at 6:00 AM Manila (cron: 0 22 * * 0)',
    description: 'Cleans up resolved or archived conversation threads in Gmail, strips active sequence labels, and logs thread status to Postgres.',
    connectors: ['Supabase Postgres', 'Gmail API'],
    targetTables: ['public.follow_up_sequence_threads'],
    downstreamNodesCount: 5
  },

  // --- Sales Daily Email Notification (Workflow: lPgAcjCPUytZ4pph) ---
  {
    id: 'n8n-sales-daily-email-notification',
    name: 'Sales Daily Summary & Action Digest',
    slug: 'n8n-sales-daily-email-notification',
    workflowName: 'Sales Daily Email Notification',
    workflowId: 'lPgAcjCPUytZ4pph',
    webhookNodeName: 'Webhook',
    webhookPath: '7dc5b0a7-071a-4a66-99e4-ab48cc23aeff',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/7dc5b0a7-071a-4a66-99e4-ab48cc23aeff',
    httpMethod: 'GET',
    category: 'Sales',
    active: true,
    cronJobName: 'n8n-sales-daily-email-notification',
    cronExpression: '50 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:50 AM Manila (22:50 UTC)',
    scheduleDesc: 'Monday through Friday at 6:50 AM Manila (cron: 50 22 * * 0-4)',
    description: 'Aggregates new incoming speaking leads, pending outreach replies, and high-priority action items; delivers automated morning digest email to the sales team.',
    connectors: ['Supabase Postgres', 'Gmail API'],
    targetTables: ['public.sales_liv_deals'],
    downstreamNodesCount: 22
  },

  // --- AC Caching (Workflow: ik1kyavpU8RrC8F3) ---
  {
    id: 'n8n-get-all-ac-accounts',
    name: 'ActiveCampaign Accounts Caching',
    slug: 'n8n-get-all-ac-accounts',
    workflowName: 'AC Caching',
    workflowId: 'ik1kyavpU8RrC8F3',
    webhookNodeName: 'Webhook2',
    webhookPath: 'ae6f429c-99a2-428c-91f9-db2cb62c16c6',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/ae6f429c-99a2-428c-91f9-db2cb62c16c6',
    httpMethod: 'GET',
    category: 'Operations',
    active: true,
    cronJobName: 'n8n-get-all-ac-accounts',
    cronExpression: '10 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:10 AM Manila (22:10 UTC)',
    scheduleDesc: 'Monday through Friday at 6:10 AM Manila (cron: 10 22 * * 0-4)',
    description: 'Pages through ActiveCampaign accounts API and caches account organizations and domain associations in local Supabase database.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_accounts'],
    downstreamNodesCount: 16
  },
  {
    id: 'n8n-get-all-ac-contacts',
    name: 'ActiveCampaign Contacts Caching (Paused)',
    slug: 'n8n-get-all-ac-contacts',
    workflowName: 'AC Caching',
    workflowId: 'ik1kyavpU8RrC8F3',
    webhookNodeName: 'Webhook1',
    webhookPath: '8388b39d-9c99-494e-9991-2fefb0081a87',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/8388b39d-9c99-494e-9991-2fefb0081a87',
    httpMethod: 'GET',
    category: 'Operations',
    active: false,
    cronJobName: 'n8n-get-all-ac-contacts',
    cronExpression: '5 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:05 AM Manila (22:05 UTC) · Paused in pg_cron',
    scheduleDesc: 'Paused in pg_cron · Superseded by Supabase Edge Function activecampaign-contacts-sync',
    description: 'Synchronized AC contacts. Paused in pg_cron as contacts synchronization is now managed by Supabase Edge Function activecampaign-contacts-sync.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_contacts'],
    downstreamNodesCount: 18
  },
  {
    id: 'n8n-get-all-ac-deals',
    name: 'ActiveCampaign Deals Caching (Paused)',
    slug: 'n8n-get-all-ac-deals',
    workflowName: 'AC Caching',
    workflowId: 'ik1kyavpU8RrC8F3',
    webhookNodeName: 'Webhook',
    webhookPath: '02b6362d-b828-4f40-908c-45e98a943a2b',
    webhookUrl: 'https://n8n-659687081407.australia-southeast1.run.app/webhook/02b6362d-b828-4f40-908c-45e98a943a2b',
    httpMethod: 'GET',
    category: 'Operations',
    active: false,
    cronJobName: 'n8n-get-all-ac-deals',
    cronExpression: '0 22 * * 0-4',
    cronHuman: 'Mon–Fri 6:00 AM Manila (22:00 UTC) · Paused in pg_cron',
    scheduleDesc: 'Paused in pg_cron · Superseded by Supabase Edge Function activecampaign-deals-sync',
    description: 'Synchronized AC deals. Paused in pg_cron as deal synchronization is now managed by Supabase Edge Function activecampaign-deals-sync.',
    connectors: ['Supabase Postgres', 'ActiveCampaign API'],
    targetTables: ['public.activecampaign_deals'],
    downstreamNodesCount: 18
  }
];

/**
 * Queries Supabase database (n8n-production project uwsncuowtzydylfabikj) for pg_cron job statuses.
 */
async function fetchSupabaseCronJobs() {
  const token = config.supabase.accessToken;
  const projectId = config.n8n.supabaseProjectId || 'uwsncuowtzydylfabikj';

  if (!token) return [];

  const sql = `
    SELECT 
      j.jobid,
      j.jobname,
      j.schedule,
      j.active,
      j.command,
      d.status as last_run_status,
      d.return_message,
      d.start_time,
      d.end_time
    FROM cron.job j
    LEFT JOIN LATERAL (
      SELECT status, return_message, start_time, end_time
      FROM cron.job_run_details
      WHERE jobid = j.jobid
      ORDER BY start_time DESC
      LIMIT 1
    ) d ON true
    ORDER BY j.jobname;
  `;

  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('[n8n-automations] Failed to query Supabase cron jobs:', err.message);
  }
  return [];
}

/**
 * Queries n8n executions via n8n REST API.
 */
async function fetchN8nExecutions() {
  const apiUrl = config.n8n.apiUrl || 'https://n8n-659687081407.australia-southeast1.run.app';
  const apiKey = config.n8n.apiKey;

  if (!apiKey) return [];

  try {
    const res = await fetch(`${apiUrl}/api/v1/executions?limit=100`, {
      headers: { 'X-N8N-API-KEY': apiKey }
    });
    if (res.ok) {
      const data = await res.json();
      return data.data || [];
    }
  } catch (err) {
    console.warn('[n8n-automations] Failed to query n8n executions:', err.message);
  }
  return [];
}

/**
 * Returns complete telemetry, catalog, and KPI summaries for all active n8n webhook automations.
 */
export async function getN8nAutomations() {
  const [cronJobs, n8nExecutions] = await Promise.all([
    fetchSupabaseCronJobs(),
    fetchN8nExecutions()
  ]);

  // Index cron jobs by jobname and by webhook path extracted from command
  const cronByJobName = new Map();
  const cronByWebhookPath = new Map();

  for (const c of cronJobs) {
    cronByJobName.set(c.jobname, c);
    const m = (c.command || '').match(/\/webhook\/([a-zA-Z0-9_-]+)/);
    if (m) {
      cronByWebhookPath.set(m[1], c);
    }
  }

  // Index n8n executions by workflowId (most recent first)
  const execsByWorkflowId = new Map();
  for (const ex of n8nExecutions) {
    if (!execsByWorkflowId.has(ex.workflowId)) {
      execsByWorkflowId.set(ex.workflowId, ex);
    }
  }

  let activeCount = 0;
  let pausedCount = 0;
  let succeededCount = 0;
  let issuesCount = 0;
  const workflowSet = new Set();

  const automations = N8N_AUTOMATIONS_CATALOG.map((item) => {
    workflowSet.add(item.workflowId);

    // Look up cron telemetry
    const cronJob = cronByJobName.get(item.cronJobName) || cronByWebhookPath.get(item.webhookPath);
    // Look up n8n execution telemetry
    const exec = execsByWorkflowId.get(item.workflowId);

    const isCronActive = cronJob ? Boolean(cronJob.active) : item.active;

    let status = 'active';
    let statusLabel = 'Active / Scheduled';
    let lastRunAt = null;
    let durationMs = null;
    let lastRunNotes = 'Ready · Waiting for next scheduled trigger';

    if (!isCronActive) {
      status = 'inactive';
      statusLabel = 'Paused (Superseded)';
      lastRunNotes = 'Paused · Supabase pg_cron disabled; workflow functionality handled by Edge Functions';
      pausedCount++;
    } else {
      activeCount++;

      // Use execution telemetry if available
      if (exec) {
        lastRunAt = exec.startedAt ? new Date(exec.startedAt).toISOString() : null;
        if (exec.startedAt && exec.stoppedAt) {
          durationMs = Math.max(0, new Date(exec.stoppedAt).getTime() - new Date(exec.startedAt).getTime());
        }

        if (exec.status === 'success') {
          status = 'succeeded';
          statusLabel = 'Succeeded';
          lastRunNotes = `Succeeded · Execution #${exec.id} finished nominal in ${durationMs ? (durationMs / 1000).toFixed(1) + 's' : 'nominal time'}`;
          succeededCount++;
        } else if (exec.status === 'error' || exec.status === 'failed') {
          status = 'failed';
          statusLabel = 'Execution Failed';
          lastRunNotes = `Failed · Execution #${exec.id} reported error on n8n runner`;
          issuesCount++;
        } else if (exec.status === 'running') {
          status = 'active';
          statusLabel = 'Running';
          lastRunNotes = `Running · Execution #${exec.id} currently in progress`;
        }
      } else if (cronJob && cronJob.start_time) {
        lastRunAt = new Date(cronJob.start_time).toISOString();
        if (cronJob.last_run_status === 'succeeded') {
          status = 'succeeded';
          statusLabel = 'Trigger Fired';
          lastRunNotes = `Trigger Fired · Supabase pg_cron dispatched HTTP GET webhook (${cronJob.return_message || '1 row'})`;
          succeededCount++;
        } else if (cronJob.last_run_status === 'failed') {
          status = 'failed';
          statusLabel = 'Cron Failed';
          lastRunNotes = `Cron Error · ${cronJob.return_message || 'Supabase pg_cron trigger failed'}`;
          issuesCount++;
        }
      } else {
        statusLabel = 'Active / Scheduled';
        lastRunNotes = `Active · Next run scheduled via pg_cron (${item.cronHuman})`;
      }
    }

    return {
      ...item,
      active: isCronActive,
      status,
      statusLabel,
      lastRunAt,
      durationMs,
      lastRunNotes,
      lastExecutionId: exec ? exec.id : null,
      cronJobId: cronJob ? cronJob.jobid : null,
      cronReturnMessage: cronJob ? cronJob.return_message : null
    };
  });

  const total = automations.length;
  const healthyPct = activeCount > 0 ? Math.round((succeededCount / activeCount) * 100) : 100;

  return {
    summary: {
      total,
      active: activeCount,
      paused: pausedCount,
      workflows: workflowSet.size,
      succeeded: succeededCount,
      issues: issuesCount,
      healthyPct
    },
    automations,
    lastPolledAt: new Date().toISOString()
  };
}
