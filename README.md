# OnGrid Partner Form — Netlify Function

Serverless proxy that receives partner form submissions from ongridsmart.com and:
1. Writes a new entry to the Notion Partner Applications database
2. Creates (or updates) a Shopify customer with partner tags so they
   appear in customer segments and abandoned checkout / email flows

Notion is the critical path -- the form fails if Notion does not write.
Shopify is best-effort -- a Shopify failure still returns success to the user.

---

## Deploy Steps

1. Push this folder to a new GitHub repo
2. Go to netlify.com -> New site from Git -> connect the repo
3. Leave build command and publish directory blank
4. Click Deploy site
5. Add the three environment variables below

---

## Environment Variables

Set all three in: Netlify dashboard -> Site settings -> Environment variables

### NOTION_TOKEN
1. Go to https://www.notion.so/my-integrations
2. Click "New integration" -> name it "OnGrid Partner Form" -> Submit
3. Copy the Internal Integration Secret (starts with secret_)
4. In Notion, open the Partner Applications database
5. Click the ... menu -> Connections -> add "OnGrid Partner Form"

### SHOPIFY_STORE
Your store handle only, no .myshopify.com suffix.
Example: ongridsmart  (not ongridsmart.myshopify.com)

### SHOPIFY_ADMIN_TOKEN
1. In Shopify Admin go to Settings -> Apps -> Develop apps
2. Create an app named "Partner Form"
3. Configure Admin API scopes: enable write_customers and read_customers
4. Save -> Install app -> copy the Admin API access token (shpat_xxx...)

---

## What Gets Written to Shopify

On every successful submission the function creates (or updates) a Shopify customer:
- Tags:      partner + track tag (partner-realtor / partner-store / partner-str / partner-other)
- Note:      track, business name, and application date
- Marketing: opted in with single opt-in consent
- Metafields: partner.track, partner.business_name, partner.applied_date

Build a Shopify customer segment on tag "partner" to trigger:
- Abandoned checkout emails targeted at partner leads
- Partner-specific flows in Shopify Email or Klaviyo
- Segment analytics by track

---

## Update the Theme After Deploying

In sections/page-partner-signup.liquid find:
  var ENDPOINT = 'https://YOUR-SITE.netlify.app/.netlify/functions/partner-submit';

Replace YOUR-SITE with your Netlify subdomain, then re-upload the theme ZIP.

---

## Test Locally

  npm install -g netlify-cli

  NOTION_TOKEN=secret_xxx SHOPIFY_STORE=ongridsmart SHOPIFY_ADMIN_TOKEN=shpat_xxx netlify dev

  curl -X POST http://localhost:8888/.netlify/functions/partner-submit \
    -H "Content-Type: application/json" \
    -d '{"partnerName":"Test Partner","businessName":"Test Co","email":"test@example.com","phone":"5205550000","city":"Tucson, AZ","partnerType":"Realtor / Agent","why":"Testing","dateApplied":"2026-05-17"}'

Expected: {"success":true,"notion":true,"shopify":true,"shopifyAction":"created"}
