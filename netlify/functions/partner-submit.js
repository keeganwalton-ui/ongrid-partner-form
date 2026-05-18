// netlify/functions/partner-submit.js
//
// Multi-form router for OnGrid lead capture. The same endpoint handles:
//
//   form_type = "partnerForm" (default)  →  Partner Applications Notion DB
//                                            + Shopify customer upsert (best-effort)
//   form_type = "savedBuild"             →  Saved Builds Notion DB
//                                            (consumer builder save-my-build flow)
//
// Required env vars (Netlify dashboard -> Site settings -> Environment variables):
//   NOTION_TOKEN          -- Notion internal integration secret (ntn_... or secret_...)
//   SHOPIFY_STORE         -- store handle only, e.g. ongrid-llc (no .myshopify.com) -- optional
//   SHOPIFY_ADMIN_TOKEN   -- Shopify Admin API access token (shpat_...)             -- optional
//
// Both target Notion databases must have the OnGrid Partner Form integration added
// as a connection (DB -> ... -> Connections -> OnGrid Partner Form).

const NOTION_DBS = {
  partnerForm: 'c3741786ad564070aa0e7d394eca3c40', // Partner Applications
  savedBuild:  '607a19f209b84e37939fd3e8632ed0cc'  // Saved Builds
};

exports.handler = async function(event) {
  const ALLOWED_ORIGIN = 'https://ongridsmart.com';

  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const formType = body.form_type || 'partnerForm';

  if (formType === 'savedBuild') {
    return handleSavedBuild(body, corsHeaders);
  }
  return handlePartnerForm(body, corsHeaders);
};

/* -----------------------------------------------------------------
   PARTNER FORM -- writes to Partner Applications + Shopify customer
   ----------------------------------------------------------------- */

async function handlePartnerForm(body, corsHeaders) {
  const { partnerName, businessName, email, phone, city, website, partnerType, why, dateApplied } = body;

  if (!partnerName || !email || !partnerType) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing required fields: partnerName, email, partnerType' })
    };
  }

  const nameParts = partnerName.trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';
  const today     = dateApplied || new Date().toISOString().split('T')[0];

  const NOTION_TOKEN        = process.env.NOTION_TOKEN;
  const SHOPIFY_STORE       = process.env.SHOPIFY_STORE;
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  const trackTagMap = {
    'Realtor / Agent':        'partner,partner-realtor',
    'Furniture / Home Store': 'partner,partner-store',
    'Airbnb / STR Host':      'partner,partner-str',
    'Other':                  'partner,partner-other'
  };
  const shopifyTags = trackTagMap[partnerType] || 'partner';

  const [notionResult, shopifyResult] = await Promise.allSettled([

    fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization':  'Bearer ' + NOTION_TOKEN,
        'Content-Type':   'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DBS.partnerForm },
        properties: {
          'Partner Name':             { title:        [{ text: { content: partnerName } }] },
          'Business Name':            { rich_text:    [{ text: { content: businessName || '' } }] },
          'Email':                    { email:        email },
          'Phone':                    { phone_number: phone || null },
          'City':                     { rich_text:    [{ text: { content: city || '' } }] },
          'Website or Social':        { url: (website && website.startsWith('http')) ? website : null },
          'Partner Type':             { select:       { name: partnerType } },
          'Why They Want to Partner': { rich_text:    [{ text: { content: why || '' } }] },
          'Status':                   { select:       { name: 'New' } },
          'Date Applied':             { date:         { start: today } },
          'Approved?':                { checkbox:     false }
        }
      })
    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); }),

    shopifyUpsertCustomer({
      store: SHOPIFY_STORE,
      token: SHOPIFY_ADMIN_TOKEN,
      firstName, lastName, email, phone,
      tags: shopifyTags,
      note: 'Partner application submitted ' + today + '. Track: ' + partnerType + '. Business: ' + (businessName || 'N/A') + '.',
      partnerType, businessName, today
    })

  ]);

  const notionOk  = notionResult.status  === 'fulfilled' && notionResult.value.ok;
  const shopifyOk = shopifyResult.status === 'fulfilled' && shopifyResult.value.ok;

  if (!notionOk)  console.error('Notion error (partner):',  JSON.stringify(notionResult.status  === 'fulfilled' ? notionResult.value  : notionResult.reason));
  if (!shopifyOk) console.error('Shopify error (partner):', JSON.stringify(shopifyResult.status === 'fulfilled' ? shopifyResult.value : shopifyResult.reason));

  if (!notionOk) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error:   'Could not save your application. Please email hello@ongridsmart.com.',
        notion:  false,
        shopify: shopifyOk
      })
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:       true,
      notion:        true,
      shopify:       shopifyOk,
      shopifyAction: shopifyOk ? shopifyResult.value.action : 'failed'
    })
  };
}

/* -----------------------------------------------------------------
   SAVED BUILD -- writes to Saved Builds DB from the consumer builder
   -----------------------------------------------------------------

   Expected payload from theme builder.js (saveBuild()):

   {
     form_type:      "savedBuild",
     email:          "...",                 // required
     phone:          "...",                 // optional
     buildName:      "Home name string",    // required (falls back to "Untitled build")
     buildId:        "ts-randhex",          // required, stable ID
     homeName:       "Home name string",    // same as buildName
     deviceSummary:  "2x Hub, 3x Sensor",   // joined device list
     roomCount:      4,                     // integer
     totalPrice:     1299.50,               // number
     protectionPlan: "Standard" | "None" | ...,
     setupGmail:     "...",                 // optional, packed into Notes
     wifiNetwork:    "...",                 // optional, packed into Notes
     shareUrl:       "https://ongridsmart.com/cart"
   }
*/

async function handleSavedBuild(body, corsHeaders) {
  const {
    email,
    phone,
    buildName,
    buildId,
    homeName,
    deviceSummary,
    roomCount,
    totalPrice,
    protectionPlan,
    setupGmail,
    wifiNetwork,
    shareUrl
  } = body;

  if (!email || !buildId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing required fields: email, buildId' })
    };
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const nowIso       = new Date().toISOString();
  const title        = (buildName && buildName.trim()) || (homeName && homeName.trim()) || 'Untitled build';

  const notesParts = [];
  if (phone)       notesParts.push('Phone: ' + phone);
  if (setupGmail)  notesParts.push('Setup Gmail: ' + setupGmail);
  if (wifiNetwork) notesParts.push('WiFi: ' + wifiNetwork);
  const notes = notesParts.join(' | ');

  const properties = {
    'Build Name':      { title:        [{ text: { content: title } }] },
    'Build ID':        { rich_text:    [{ text: { content: buildId } }] },
    'Customer Email':  { email:        email },
    'Devices':         { rich_text:    [{ text: { content: deviceSummary || '' } }] },
    'Home Name':       { rich_text:    [{ text: { content: (homeName || title) } }] },
    'Notes':           { rich_text:    [{ text: { content: notes } }] },
    'Room Count':      { number:       (typeof roomCount === 'number' ? roomCount : null) },
    'Total Price':     { number:       (typeof totalPrice === 'number' ? totalPrice : null) },
    'Saved At':        { date:         { start: nowIso } },
    'Last Viewed':     { date:         { start: nowIso } },
    'Status':          { select:       { name: 'New' } }
  };

  if (protectionPlan) {
    properties['Protection Plan'] = { select: { name: protectionPlan } };
  }
  if (shareUrl && shareUrl.startsWith('http')) {
    properties['Share URL'] = { url: shareUrl };
  }

  const notionRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization':  'Bearer ' + NOTION_TOKEN,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DBS.savedBuild },
      properties: properties
    })
  });

  const notionData = await notionRes.json();
  const notionOk   = notionRes.ok;

  if (!notionOk) {
    console.error('Notion error (savedBuild):', JSON.stringify(notionData));
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error:   'Could not save your build. Please try again.',
        notion:  false
      })
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ success: true, notion: true, form_type: 'savedBuild' })
  };
}

/* -----------------------------------------------------------------
   Shared helper: upsert a Shopify customer (partner form only)
   ----------------------------------------------------------------- */

async function shopifyUpsertCustomer({ store, token, firstName, lastName, email, phone, tags, note, partnerType, businessName, today }) {
  if (!store || !token) {
    return { ok: false, action: 'skipped-no-credentials' };
  }

  const baseUrl = 'https://' + store + '.myshopify.com/admin/api/2024-04';

  const searchRes = await fetch(
    baseUrl + '/customers/search.json?query=email:' + encodeURIComponent(email) + '&fields=id,email,tags',
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
  );
  const searchData = await searchRes.json();
  const existing   = searchData.customers && searchData.customers[0];

  if (existing) {
    const existingTags = existing.tags ? existing.tags.split(', ').map(function(t) { return t.trim(); }) : [];
    const newTagList   = tags.split(',').map(function(t) { return t.trim(); });
    const mergedTags   = Array.from(new Set(existingTags.concat(newTagList))).join(', ');

    const res = await fetch(
      baseUrl + '/customers/' + existing.id + '.json',
      {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: { id: existing.id, tags: mergedTags, note: note } })
      }
    );
    const data = await res.json();
    return { ok: res.ok, action: 'updated', data: data };
  }

  const res = await fetch(
    baseUrl + '/customers.json',
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: {
          first_name:        firstName,
          last_name:         lastName,
          email:             email,
          phone:             phone || null,
          tags:              tags,
          note:              note,
          accepts_marketing: true,
          email_marketing_consent: {
            state:              'subscribed',
            opt_in_level:       'single_opt_in',
            consent_updated_at: new Date().toISOString()
          },
          metafields: [
            { namespace: 'partner', key: 'track',         value: partnerType,         type: 'single_line_text_field' },
            { namespace: 'partner', key: 'business_name', value: businessName || '',  type: 'single_line_text_field' },
            { namespace: 'partner', key: 'applied_date',  value: today,               type: 'date' }
          ]
        }
      })
    }
  );
  const data = await res.json();
  return { ok: res.ok, action: 'created', data: data };
}
