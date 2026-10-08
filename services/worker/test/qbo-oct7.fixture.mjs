/* The Oct 7 read the QuickBooks matcher was designed on, trimmed for its
   tests (test/qbomatch.test.mjs). Not a test file: node --test runs only
   test/*.test.mjs.

   PURCHASES: every QuickBooks expense dated 2026-09-17 to 2026-10-08 (the
   window listPurchases is asked for when today is 2026-10-08 and the oldest
   live receipt is dated 9/18), from a read-only query of the books on Oct 7.
   Trimmed: personal rows (an owner draw, a payroll advance, personal cards,
   a gym, a subcontractor paid by name), one memo holding a phone number and
   one software subscription are left out, line class names are dropped, and
   a person's name on a line's customer is replaced. Sync tokens are
   stand-ins ("0") except those read: 10563 (1), 10566 (2) and 10577 (0).
   Columns:
     id|txnDate|account|paymentType|credit|vendor|total|docNumber|memo|lines|attachments
   lines: "expense account:customer id:ProjectRef" joined by ";".

   RECEIPTS: the 28 live job_receipts rows of Oct 7, as their fields read
   (vendor, date, total, paid with, card, receipt number). Receipt ids,
   photo markers and the rest of each job id are stand-ins (only the first
   eight characters of a job id were kept); category is "materials" except
   the FNSB dump ticket.

   PROJECTS: the QuickBooks projects (Customers with Job = true) these rows
   touch, as listProjects returns them. */

export const TODAY = "2026-10-08";

export const JOBS = {
  alston: "a628eea5-0000-4000-8000-000000000001",       // "2156 Alston rd."; its store invoices are tagged to 112 Pollen Apartments
  chena: "0b32c79a-0000-4000-8000-000000000002",
  beechwood: "e02d10c1-0000-4000-8000-000000000003",
  polarfox: "b8fe20f0-0000-4000-8000-000000000004",
  brighton: "e19464b0-0000-4000-8000-000000000005",
};

export const JOB_ROWS = [
  { id: JOBS.alston, title: "", address: "2156 Alston rd.", customer: "", qbJobcodeName: "", deleted: false, link: null },
  { id: JOBS.chena, title: "", address: "1885 Chena Landings Lp.", customer: "", qbJobcodeName: "", deleted: false, link: null },
  { id: JOBS.beechwood, title: "", address: "292 Beechwood St.", customer: "", qbJobcodeName: "", deleted: false, link: null },
  { id: JOBS.polarfox, title: "", address: "4109 Polar Fox", customer: "", qbJobcodeName: "", deleted: false, link: null },
  { id: JOBS.brighton, title: "", address: "330 Brighton", customer: "", qbJobcodeName: "", deleted: false, link: null },
];

const ACCOUNTS = {
  "9": "8992-MMB- Checking",
  "36": "3176 - Citi - Home Depot Consumer Credit Card",
  "37": "1658 - Bank of America AK Air CC",
  "52": "Sherwin Williams Store Credit Account",
  "53": "Spenard Builders (SBS) - Store Credit",
  "85": "ATM Cash Clearing",
  "240": "1674 US Bank - Amazon (0687)",
};
const VENDOR_IDS = { "Home Depot": "25", "Spenard Building Supply": "65", "Sherwin Williams": "9" };
const CUSTOMERS = { "111": "Customer 111", "112": "Pollen Apartments", "399": "264 Cindy dr.", "444": "1192 Bemis Ct.",
  "470": "3018 Nate Circle", "502": "1885 Chena Landings Lp." };
const SYNC_TOKENS = { "10563": "1", "10566": "2" };
const PAYMENT_TYPES = { CC: "CreditCard", Cash: "Cash", Check: "Check" };

const PURCHASE_ROWS = `
10456|2026-09-17|240|CC|F|Home Depot|50|193594|Deposit on rented carpet cleaner|1150040005:112:412739523|IMG_9555.jpg
10457|2026-09-17|240|CC|F|Home Depot|19.6|6010382|job materials|42:399:774437554|IMG_9552.jpeg
10458|2026-09-17|240|CC|F|Home Depot|34.37|6024013|Job materials|42:399:774437554|IMG_9546.jpeg
10459|2026-09-17|240|CC|F|Home Depot|126.38|6010352|Job materials|42:399:774437554|IMG_9549.jpeg
10460|2026-09-17|240|CC|F|Home Depot|71.96|6010377|Cleaning supplies, Job materials purchased|15::;42:399:774437554|IMG_9553.jpeg
10461|2026-09-17|240|CC|F|Lowe's|15|57746|GE OTR microwave (15 on card, 224 cash)|42:112:412739523|IMG_9547.jpeg
10462|2026-09-17|85|Cash|F|Lowe's|224|645638777|GE OTR microwave (15 on card, 224 cash)|42:112:412739523|IMG_9547.jpeg
10478|2026-09-17|240|CC|T|Home Depot|69.51|6200405|Materials returned|42:399:774437554|IMG_9548.jpeg
10481|2026-09-17|240|CC|F|Home Depot|39.3|5024140|The Home Depot #1303 Fairbanks Ak|42:111:|IMG_9582.jpeg
10482|2026-09-17|240|CC|F|Home Depot|21.98||The Home Depot #1303 Fairbanks Ak|42::|
10454|2026-09-18|240|CC|F|Home Depot|50|193615|Deposit on equipment rental - Tile roller|1150040005:112:412739523|IMG_9545.jpeg,IMG_9545.jpeg
10488|2026-09-18|53|CC|F|Spenard Building Supply|6.34|700582348|Materials, towels for job|42:399:774437554;1150040018:399:774437554|SBS_InvNo_700582348.pdf
10489|2026-09-18|53|CC|F|Spenard Building Supply|18.47|700584001|FANTASTIC SPRAY CLEANER, GLOVE|1150040018:112:412739523|SBS_InvNo_700584001.pdf
10490|2026-09-18|53|CC|F|Spenard Building Supply|41.76|700584141|Door stops|42:399:774437554|SBS_InvNo_700584141.pdf
10492|2026-09-18|52|CC|F|Sherwin Williams|64.99|76527163000926|Materials|42:112:412739523|SW_InvNo_76527163000926.pdf,IMG_9575.jpg
10540|2026-09-20|240|CC|T|Home Depot|99||The Home Depot #1303 Fairbanks Ak|42:399:774437554|IMG_9583.jpeg
10541|2026-09-20|240|CC|F|Chena Hot Springs Gas|200||Hot Springs Gas Fairbanks Ak|56::|IMG_9584.jpeg
10542|2026-09-20|240|CC|T|Ferguson Plumbing Supply|110.25||Ferguson Ent #3022 Fairbanks Ak|42:399:774437554|IMG_9585.jpeg
10501|2026-09-21|240|CC|F|Amazon|647.68||Amazon Mark* 5r2j58if2 Seattle Wa - RULE - ATTACHMENTS ARE BUSINESS RELATED.|29::|
10543|2026-09-21|240|CC|F|US Bank (Amazon CC)|40||Late Fee - Payment Due On 09/22|45::|
10544|2026-09-21|240|CC|F|Home Depot|456.15||The Home Depot #1303 Fairbanks Ak|42:444:788830886|IMG_9595.jpeg
10545|2026-09-21|240|CC|F|Lowe's|179.52||Lowes #01985* Fairbanks Ak  - RULE|42:112:412739523|IMG_9586.jpeg
10559|2026-09-21|53|CC|F|Spenard Building Supply|25.13|700590337|Job materials|42:112:412739523|SBS_InvNo_700590337.pdf
10499|2026-09-22|240|CC|F|American Express Credit Card|435.88||Interest Charge On Purchases - RULE|186::|
10500|2026-09-22|240|CC|F|Amazon|54.95||Amazon Mark* 5x3bc9vn1 Seattle Wa - RULE - ATTACHMENTS ARE BUSINESS RELATED.|29::|
10528|2026-09-22|9|Cash|F|Intuit|2915.24||INTUIT FINANCING QBC_PMTS|116::|
10529|2026-09-22|9|Cash|F|Intuit|3399.63||INTUIT FINANCING QBC_PMTS|116::|
10530|2026-09-22|9|Cash|F|Intuit|1904.93||INTUIT FINANCING QBC_PMTS|116::|
10538|2026-09-22|9|Cash|F|AT&T|120.9||ATT PAYMENT|63::|
10546|2026-09-22|240|CC|F|Seamless Supply, Inc|364.15|58969|Seamless Supply North Pole Ak|42:444:788830886|IMG_9606.jpg,IMG_9596.jpg
10547|2026-09-22|240|CC|F|Home Depot|35.81||The Home Depot #1303 Fairbanks Ak|42:444:788830886|IMG_9607.jpeg
10556|2026-09-22|53|CC|F|Spenard Building Supply|245.79|700595508|Materials purchased|42:444:788830886|IMG_9587.jpg
10494|2026-09-23|9|Cash|F|GVEA|260||Temporary power permit|1150040018:502:807760362|
10523|2026-09-23|37|CC|T|Bank of America|1671||ONLINE/MOBILE PAYMENT CONF|1150040008::|
10524|2026-09-23|37|CC|F|Bank of America|1671||ONLINE/MOBILE TRANSFER PAYMENT RETURN|1150040008::|
10536|2026-09-23|9|Cash|F|Circle K|100||4558 VSA PUR CIRCLEK 2746641 FAIRBANKS AK|56::|
10537|2026-09-23|9|Cash|F|Circle K|85.08||4558 VSA PUR CIRCLEK 2746641 FAIRBANKS AK|56::|
10548|2026-09-23|240|CC|T|Home Depot|354.25||The Home Depot #1303 Fairbanks Ak|42::|
10554|2026-09-23|53|CC|F|Spenard Building Supply|21.81|700604868|3/16 SS METAL DEMON DRILL|42:112:412739523|IMG_9608.jpeg
10555|2026-09-23|53|CC|F|Spenard Building Supply|89.28|700603509|5/8 GYP TYPE-X|42:444:788830886|IMG_9609.jpg
10560|2026-09-23|53|CC|F|Spenard Building Supply|67.87|700602163|Job materials|42:112:412739523|SBS_InvNo_700602163.pdf
10526|2026-09-24|37|CC|F|HP Instant Ink|6.98||HP *INSTANT INK|15::|
10531|2026-09-24|9|Cash|F|Bank of America|1671||BANK OF AMERICA PAYMENT|1150040008::|
10561|2026-09-24|53|CC|T|Spenard Building Supply|46.66|800047845|Materials returned|42:444:788830886|SBS_Credit_800047845.pdf
10509|2026-09-25|36|CC|F|Home Depot|349.46|8010976|THE HOME DEPOT FAIRBANKS AK - RULE|42:111:|IMG_9611.jpeg
10510|2026-09-25|36|CC|F|Home Depot|38.46||THE HOME DEPOT FAIRBANKS AK - RULE|42::|IMG_9610.jpeg
10535|2026-09-25|9|Cash|F|Bank of America|25||RETURNED ITEM CHARGE BANK OF AMERICA PAYMENT|59::|
10549|2026-09-25|85|Cash|F|Florcraft Carpet One|241.26|1344|Adh Taylor Rubb Xx Vinyl Floor Adh|42:112:412739523|IMG_9597.jpg
10527|2026-09-26|37|CC|F|Intuit|38||INTUIT *QBooks Online|197::|
10508|2026-09-27|9|Cash|F|QuickBooks Payments|156.6||System-recorded fee for QuickBooks Payments|16::|
10514|2026-09-28|240|CC|F|Amazon|12.99||Amazon Mark* 5x8rc09k2 Seattle Wa - RULE - ATTACHMENTS ARE BUSINESS RELATED.|29::|
10519|2026-09-28|36|CC|F|Home Depot|67.88||THE HOME DEPOT FAIRBANKS AK - RULE|42::|
10520|2026-09-28|36|CC|F|Home Depot|1747.68||THE HOME DEPOT FAIRBANKS AK - RULE|42::|
10562|2026-09-28|53|CC|F|Spenard Building Supply|454.47|700624399|Materials purchased|42:502:807760362|SBS_InvNo_700624399.pdf
10563|2026-09-28|53|CC|F|Spenard Building Supply|212.28|700624817|Materials purchased|42:112:412739523|SBS_InvNo_700624817.pdf
10566|2026-09-28|52|CC|F|Sherwin Williams|36|80669163000926|Job materials|42:112:412739523|SW_InvNo_80669163000926.pdf
10567|2026-09-28|52|CC|F|Sherwin Williams|179.75|80560163000926|Paint purchased|42:112:412739523|SW_InvNo_80560163000926.pdf
10539|2026-09-29|240|CC|T|US Bank (Amazon CC)|1120||Internet Payment Thank You|1150040008::|
10516|2026-09-30|9|Cash|F|Apex General Contracting Inc.|1500|435||83:444:788830886|IMG_9628.jpeg
10518|2026-09-30|9|Cash|F|QuickBooks Payments|322.54||System-recorded fee for QuickBooks Payments|16::|
10522|2026-09-30|9|Cash|F|Mt. McKinley bank|5||SERVICE CHARGE - RULE|59::|
10525|2026-09-30|37|CC|T|Bank of America|1671||ONLINE/MOBILE PAYMENT CONF|1150040008::|
10533|2026-09-30|9|Cash|F|Miscellaneous Vendor|20||CURSOR, AI POWER CURSOR, AI|197::|
10564|2026-09-30|53|CC|T|Spenard Builders Payments|1136.54|Pmt|Payment on balance|1150040008::|
10565|2026-09-30|9|Cash|F|Spenard Builders Payments|1136.54||Payment on account|1150040008::|
10570|2026-09-30|9|Cash|F|Sherwin Williams|632.92||Payment on account|1150040008::|
10571|2026-09-30|52|CC|T|Sherwin Williams|632.92|pmt|Payment on account|1150040008::|
10572|2026-09-30|9|Cash|F|US Bank (Amazon CC)|1120||U.S. BANK WEB PYMT|1150040008::|
10574|2026-09-30|9|Cash|F|Bank of America|1671||BANK OF AMERICA PAYMENT|1150040008::|
10577|2026-09-30|36|CC|F|Home Depot|1369.5||THE HOME DEPOT FAIRBANKS AK - RULE|42::|
10568|2026-10-01|52|CC|F|Sherwin Williams|32.45|82061163001026|Job materials|42:112:412739523|SW_InvNo_82061163001026.pdf
10569|2026-10-01|52|CC|F|Sherwin Williams|16.55|81998163001026|Job materials|42:112:412739523|SW_InvNo_81998163001026.pdf
10584|2026-10-01|36|CC|F|Home Depot|27.9||THE HOME DEPOT FAIRBANKS AK - RULE|42::|
10581|2026-10-02|9|Cash|F|QuickBooks Payments|74.75||System-recorded fee for QuickBooks Payments|16::|
10585|2026-10-02|9|Cash|F|Interior Conex & Storage, LLC|300||4558 VSA PUR INTERIOR CONEX STORAG - RULE|1150040005::|
10586|2026-10-02|9|Cash|F|Speedway|24.17||4558 PUR SPEEDWAY FAIRBANKS AK - RULE|56::|
10587|2026-10-02|9|Cash|F|Interior Conex & Storage, LLC|200||4558 VSA PUR INTERIOR CONEX STORAG - RULE|1150040005::|
10614|2026-10-02|36|CC|F|Home Depot|45.06||THE HOME DEPOT FAIRBANKS AK - RULE|42::|
10615|2026-10-02|37|CC|F|Airport Equipment Rental, Inc|126.9||AIRPORT EQUIPMENT RENTAL FAIRBANKS AK - RULE|1150040005::|
10592|2026-10-04|9|Cash|F|QuickBooks Payments|513.45||System-recorded fee for QuickBooks Payments|16::|
10611|2026-10-05|9|Cash|F|Copperpoint Insurance Companies|6997|||70::|Billing_Invoice.pdf
10612|2026-10-05|9|Cash|F|KA Properties, LLC|1666.5|||12::|
10616|2026-10-05|37|CC|F|Airport Equipment Rental, Inc|94||AIRPORT EQUIPMENT RENTAL FAIRBANKS AK - RULE|1150040005::|
`;

/** The rows above as qbo-proxy listPurchases returns them. */
export const PURCHASES = PURCHASE_ROWS.trim().split("\n").map((row) => {
  const [id, txnDate, account, ptype, credit, vendor, total, docNumber, note, lines, files] = row.split("|");
  const ls = lines.split(";");
  const attachments = files ? files.split(",") : [];
  return {
    id, syncToken: SYNC_TOKENS[id] ?? "0", txnDate, total: Number(total), credit: credit === "T",
    paymentType: PAYMENT_TYPES[ptype], accountId: account, accountName: ACCOUNTS[account] ?? "",
    vendorId: VENDOR_IDS[vendor] ?? "", vendorName: vendor, docNumber, note,
    lines: ls.map((l, i) => {
      const [acct, customerId, projectRef] = l.split(":");
      return { id: String(i + 1), amount: ls.length === 1 ? Number(total) : 0, detailType: "AccountBasedExpenseLineDetail",
        accountId: acct, accountName: "", classId: "", customerId, customerName: CUSTOMERS[customerId] ?? "", projectRef };
    }),
    attachments, hasAttachment: attachments.length > 0,
  };
});

// job|vendor|date|amount|paid_with|card_last4|receipt_no
const RECEIPT_ROWS = `
alston|Spenard Builders Supply|2026-09-18|18.47|account||700584001
alston|Sherwin-Williams Fairbanks Store 708285|2026-09-28|36.00|account||8066-9
alston|The Home Depot #1303|2026-09-28|67.88|card|3176|1303 00002 79356
alston|Spenard Builders Supply|2026-09-28|212.28|account||700624817
alston|The Home Depot #1303|2026-09-28|1747.68|card|3176|1303 01 46647
alston|The Home Depot #1303|2026-09-30|1369.50|card|3176|1303 00001 50615
alston|Spenard Builders Supply|2026-10-01|6.99|account||700643368
alston|The Home Depot #1303|2026-10-01|27.90|card|3176|1303 00001 52447
alston|Sherwin-Williams Fairbanks Store 708285|2026-10-01|32.45|account||8206-1
alston|FNSB Solid Waste Division #001|2026-10-01|34.04|account||01286734
alston|Spenard Builders Supply|2026-10-01|44.71|account||700641116
alston|Sherwin-Williams Fairbanks Store 708285|2026-10-02|11.13|account||8230-1
alston|The Home Depot #1303|2026-10-02|45.06|card|3176|1303 00002 87987
beechwood|Spenard Builders Supply|2026-10-02|130.03|account||700646281
chena|FS&G Aggregate Inc.|2026-10-03|100.98|account||209998
alston|The Home Depot #1303|2026-10-05|8.80|card|3176|1303 00001 59293
alston|Spenard Builders Supply|2026-10-05|36.06|account||700655224
alston|Spenard Builders Supply|2026-10-05|38.07|account||700653400
beechwood|Spenard Builders Supply|2026-10-05|87.77|account||700653391
alston|The Home Depot #1303|2026-10-05|161.78|card|3176|1303 00002 94603
chena|Spenard Builders Supply|2026-10-05|585.55|account||700655947
polarfox|Spenard Builders Supply|2026-10-06|28.32|account||700661209
chena|Spenard Builders Supply|2026-10-06|68.10|account||700660716
brighton|C & R Pipe and Steel, Inc.|2026-10-06|622.00|card|0442|1044131
chena|Spenard Builders Supply|2026-10-07|0.00|account||7066665392
chena|Spenard Builders Supply|2026-10-07|431.34|account||700667236
chena|Fairbanks Block & Building Materials|2026-10-07|956.23|card|0442|101083
chena|Spenard Builders Supply|2026-10-07|1146.75|account||700665392
`;

const hex64 = (n) => n.toString(16).padStart(2, "0").repeat(32);

/** The receipts as the lane reads job_receipts (ids r01…r28 in the order above). */
export const RECEIPTS = RECEIPT_ROWS.trim().split("\n").map((row, i) => {
  const [job, vendor, receipt_date, amount, paid_with, card_last4, receipt_no] = row.split("|");
  return {
    job_id: JOBS[job], id: `r${String(i + 1).padStart(2, "0")}`, vendor, receipt_date, amount: Number(amount),
    category: /FNSB/.test(vendor) ? "dump" : "materials", paid_with, card_last4, receipt_no,
    photo_ref: `media:${hex64(i + 1)}:${20000 + i}`,
  };
});

/** listProjects rows for the customers above and the five jobs. */
export const PROJECTS = [
  ["112", "111", "Pollen Apartments"], ["272", "111", "Pollen Water Damage"], ["399", "432", "264 Cindy dr."],
  ["444", "443", "1192 Bemis Ct."], ["470", "469", "3018 Nate Circle"], ["502", "501", "1885 Chena Landings Lp."],
  ["514", "513", "330 Brighton Sub", false], ["515", "514", "330 Brighton"], ["517", "516", "292 Beechwood St."],
  ["518", "100000021", "4109 Polar Fox"],
].map(([id, parentId, name, isProject = true]) => ({ id, name, fqn: "", parentId, isProject }));
