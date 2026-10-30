// ---------------------------------------------------------------------
// Instellingen -- pas REPO aan als je dit ooit in een andere repository
// gebruikt.
// ---------------------------------------------------------------------
const REPO = "jacj-dev/weekplanner";
const BRANCH = "main";
const NOTITIES_PATH = "data/lesnotities.json";
const TOKEN_KEY = "weekplanner_gh_token";

// Invulvelden per les, in de volgorde van de lesopbouw. Wil je een veld
// toevoegen, hernoemen of weghalen? Pas dan alleen deze lijst aan.
// - sleutel: naam waaronder het in lesnotities.json wordt bewaard
//   (verander die liever niet meer als er al iets in is ingevuld)
// - label:   wat je op de site ziet
// - hint:    grijze voorbeeldtekst in een leeg veld
// - eenregelig: true = kort tekstvak van één regel i.p.v. een groot vak
const LESVELDEN = [
  { sleutel: "titel", label: "Titel", hint: "Kort: wat doe je deze les? (zichtbaar in het overzicht)", eenregelig: true },
  { sleutel: "mededelingen", label: "Mededelingen", hint: "Bv. SO volgende week, excursie, toetsrooster…" },
  { sleutel: "huiswerk_nu", label: "Huiswerk voor deze les", hint: "Wat moesten ze voor vandaag doen? Hoe controleer je het?" },
  { sleutel: "activerend", label: "Activerende taak", hint: "Startopdracht / voorkennis ophalen" },
  { sleutel: "nieuwe_stof", label: "Nieuwe stof om uit te leggen", hint: "Kernbegrippen, paragraaf, uitleg" },
  { sleutel: "verwerking", label: "Verwerking / zelfstandig werken", hint: "Opgaven, practicum, samenwerkopdracht" },
  { sleutel: "terugkoppeling", label: "Terugkoppelende taak (deze les)", hint: "Exit ticket, check of het doel gehaald is" },
  { sleutel: "huiswerk_volgende", label: "Huiswerk voor volgende keer", hint: "Opgaven + inleverdatum" },
  { sleutel: "einde_les", label: "Einde les", hint: "Afsluiting, opruimen, vooruitblik" },
  { sleutel: "notitie", label: "Overige notities", hint: "" },
];

let lesnotities = {}; // { "<les-id>": { notitie: "...", links: [...] } }
let lesnotitiesSha = null; // nodig om een bestaand bestand op GitHub te overschrijven
let openIds = new Set(); // welke lessen zijn opengeklapt

// ---------------------------------------------------------------------
// GitHub-token: wordt alleen lokaal in déze browser bewaard (localStorage),
// nooit in de website-bestanden zelf. Zo blijft je sleutel uit de
// (openbare) broncode van je site.
// ---------------------------------------------------------------------

function haalToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function vraagToken() {
  const huidige = haalToken();
  const nieuw = prompt(
    "Plak je GitHub fine-grained token (met Contents: Read/Write op deze " +
      "ene repository). Laat leeg en klik OK om de opgeslagen sleutel te wissen.",
    huidige
  );
  if (nieuw === null) return huidige; // geannuleerd
  if (nieuw.trim() === "") {
    localStorage.removeItem(TOKEN_KEY);
    return "";
  }
  localStorage.setItem(TOKEN_KEY, nieuw.trim());
  return nieuw.trim();
}

function zorgVoorToken() {
  let token = haalToken();
  if (!token) token = vraagToken();
  return token;
}

// ---------------------------------------------------------------------
// GitHub Contents API: lezen kan zonder token (publieke repository),
// schrijven heeft een token met "Contents: Read and write" nodig.
// ---------------------------------------------------------------------

// Blokkeert alleen de handjevol schema's die in een browser code kunnen
// uitvoeren (javascript:/vbscript:) of om andere redenen riskant zijn
// (data: kan een compleet HTML-document met script bevatten). Alles anders
// -- https://, mailto:, relatieve paden zoals "materialen/x.pptx", maar ook
// ms-word:/ms-excel:/ms-powerpoint: (de "open direct in de desktop-app"-
// trucjes) -- blijft gewoon toegestaan.
const GEVAARLIJKE_LINKSCHEMAS_RE = /^(javascript|vbscript|data):/i;

function isVeiligeLinkTarget(target) {
  const t = (target || "").trim();
  if (!t) return false;
  return !GEVAARLIJKE_LINKSCHEMAS_RE.test(t);
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

async function githubGetFile(path) {
  const token = haalToken();
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`;
  const resp = await fetch(url, { headers });

  if (resp.status === 404) return { content: null, sha: null };
  if (!resp.ok) throw new Error(`GitHub-API gaf ${resp.status} terug bij het lezen van ${path}`);

  const data = await resp.json();
  const tekst = b64DecodeUtf8(data.content.replace(/\n/g, ""));
  return { content: JSON.parse(tekst), sha: data.sha };
}

async function githubPutFile(path, obj, sha, boodschap) {
  const token = zorgVoorToken();
  if (!token) throw new Error("Geen token ingesteld -- opslaan is geannuleerd.");

  const body = {
    message: boodschap,
    content: b64EncodeUtf8(JSON.stringify(obj, null, 2)),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const fouttekst = await resp.text();
    const fout = new Error(`Opslaan mislukt (${resp.status}): ${fouttekst}`);
    fout.status = resp.status;
    throw fout;
  }
  const data = await resp.json();
  return data.content.sha; // nieuwe sha, nodig voor de volgende keer opslaan
}

async function slaLesnotitiesOp(lesId, boodschap) {
  try {
    const nieuweSha = await githubPutFile(NOTITIES_PATH, lesnotities, lesnotitiesSha, boodschap);
    lesnotitiesSha = nieuweSha;
  } catch (fout) {
    if (fout.status !== 409) throw fout;
    // 409 = een ander apparaat/tabblad heeft het bestand ondertussen ook
    // gewijzigd (onze "sha" is verouderd). We halen de nieuwste versie op,
    // passen daar alléén deze ene les op toe, en proberen het nog één keer
    // -- zo overschrijven we niet per ongeluk wat daar ondertussen is
    // opgeslagen.
    const eigenWaarde = lesnotities[lesId];
    const info = await githubGetFile(NOTITIES_PATH);
    lesnotities = info.content || {};
    if (eigenWaarde) lesnotities[lesId] = eigenWaarde;
    else delete lesnotities[lesId];
    lesnotitiesSha = info.sha;

    const nieuweSha = await githubPutFile(NOTITIES_PATH, lesnotities, lesnotitiesSha, boodschap);
    lesnotitiesSha = nieuweSha;
  }
}

// ---------------------------------------------------------------------
// Rooster + notities laden en tonen
// ---------------------------------------------------------------------

async function laadAlles() {
  const container = document.getElementById("rooster");
  try {
    const roosterResp = await fetch("data/rooster.json");
    if (!roosterResp.ok) throw new Error("rooster.json niet gevonden");
    const roosterData = await roosterResp.json();

    try {
      const info = await githubGetFile(NOTITIES_PATH);
      lesnotities = info.content || {};
      lesnotitiesSha = info.sha;
    } catch (fout) {
      console.error("Kon lesnotities.json niet laden, ga uit van leeg:", fout);
      lesnotities = {};
      lesnotitiesSha = null;
    }

    toonRooster(roosterData.lessons, container);
  } catch (fout) {
    container.textContent =
      "Kon het rooster nog niet laden. Is de GitHub Action al een keer gedraaid?";
    console.error(fout);
  }
}

// Leest een veld uit een lesnotitie. Oude notities (van vóór de losse
// velden) hebben alleen "notitie" op het hoogste niveau; die tonen we in
// "Overige notities", zodat er niets verloren gaat.
function haalVeld(data, sleutel) {
  if (!data) return "";
  if (data.velden && data.velden[sleutel] != null) return data.velden[sleutel];
  if (sleutel === "notitie" && typeof data.notitie === "string") return data.notitie;
  return "";
}

function zetOnderwerp(el, tekst) {
  const t = (tekst || "").trim();
  el.textContent = t;
  el.hidden = !t;
}

function vandaagStr() {
  const nu = new Date();
  const jaar = nu.getFullYear();
  const maand = String(nu.getMonth() + 1).padStart(2, "0");
  const dag = String(nu.getDate()).padStart(2, "0");
  return `${jaar}-${maand}-${dag}`;
}

function toonRooster(lessen, container) {
  container.innerHTML = "";

  const vandaag = vandaagStr();
  const komendeLessen = lessen.filter((les) => les.date >= vandaag);

  const perDag = {};
  for (const les of komendeLessen) {
    if (!perDag[les.date]) perDag[les.date] = [];
    perDag[les.date].push(les);
  }

  const datums = Object.keys(perDag).sort();
  if (datums.length === 0) {
    container.textContent = "Geen aankomende lessen gevonden.";
    return;
  }

  for (const datum of datums) {
    const kop = document.createElement("h3");
    kop.textContent = new Date(datum + "T00:00:00").toLocaleDateString("nl-NL", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    container.appendChild(kop);

    const lijst = document.createElement("ul");
    lijst.className = "lessen-lijst";
    for (const les of perDag[datum]) lijst.appendChild(bouwLesItem(les));
    container.appendChild(lijst);
  }
}

function bouwLesItem(les) {
  const item = document.createElement("li");
  item.className = "les" + (les.cancelled ? " vervallen" : les.changed ? " gewijzigd" : "");
  if (openIds.has(les.id)) item.classList.add("open");

  const kop = document.createElement("div");
  kop.className = "les-kop";

  const tijd = document.createElement("span");
  tijd.className = "les-tijd";
  tijd.textContent = `${les.start}–${les.end}`;

  const titel = document.createElement("span");
  titel.className = "les-titel";
  const code = document.createElement("span");
  code.className = "les-code";
  code.textContent = les.summary;
  titel.appendChild(code);

  // Lestitel uit de notities, zichtbaar als de les is ingeklapt
  const onderwerp = document.createElement("span");
  onderwerp.className = "les-onderwerp";
  zetOnderwerp(onderwerp, haalVeld(lesnotities[les.id], "titel"));
  titel.appendChild(onderwerp);

  kop.appendChild(tijd);
  kop.appendChild(titel);

  if (les.cancelled) {
    const label = document.createElement("span");
    label.className = "les-label";
    label.textContent = "vervallen";
    kop.appendChild(label);
  } else if (les.changed) {
    const label = document.createElement("span");
    label.className = "les-label";
    label.textContent = "gewijzigd";
    kop.appendChild(label);
  }

  const notitieData = lesnotities[les.id];
  const ingevuld = LESVELDEN.filter((v) => (haalVeld(notitieData, v.sleutel) || "").trim()).length;
  if (ingevuld > 0) {
    const vbadge = document.createElement("span");
    vbadge.className = "les-linkbadge les-veldbadge";
    vbadge.textContent = `${ingevuld}/${LESVELDEN.length} ingevuld`;
    kop.appendChild(vbadge);
  }
  const linkAantal = notitieData && notitieData.links ? notitieData.links.length : 0;
  if (linkAantal > 0) {
    const badge = document.createElement("span");
    badge.className = "les-linkbadge";
    badge.textContent = linkAantal === 1 ? "1 link" : `${linkAantal} links`;
    kop.appendChild(badge);
  }

  const pijl = document.createElement("span");
  pijl.className = "les-pijl";
  pijl.textContent = "›";
  kop.appendChild(pijl);

  kop.addEventListener("click", () => {
    item.classList.toggle("open");
    if (item.classList.contains("open")) openIds.add(les.id);
    else openIds.delete(les.id);
  });

  item.appendChild(kop);
  item.appendChild(bouwLesDetail(les));
  return item;
}

function bouwLesDetail(les) {
  const detail = document.createElement("div");
  detail.className = "les-detail";

  if (les.change_note) {
    const notice = document.createElement("div");
    notice.className = "les-wijziging";
    notice.textContent = (les.cancelled ? "Vervallen — " : "Gewijzigd — ") + les.change_note;
    detail.appendChild(notice);
  }

  const bestaand = lesnotities[les.id] || { links: [] };

  // Invulvelden (zie LESVELDEN bovenaan)
  const veldInvoer = {};
  for (const veld of LESVELDEN) {
    const veldId = `veld-${les.id}-${veld.sleutel}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const label = document.createElement("label");
    label.textContent = veld.label;
    label.htmlFor = veldId;
    const invoer = document.createElement(veld.eenregelig ? "input" : "textarea");
    if (veld.eenregelig) invoer.type = "text";
    invoer.id = veldId;
    invoer.className = "les-veld" + (veld.eenregelig ? " les-veld-kort" : "");
    invoer.placeholder = veld.hint;
    invoer.value = haalVeld(bestaand, veld.sleutel) || "";
    if (!veld.eenregelig) {
      // groeit mee met de tekst
      const pasHoogteAan = () => {
        invoer.style.height = "auto";
        invoer.style.height = invoer.scrollHeight + 2 + "px";
      };
      invoer.addEventListener("input", pasHoogteAan);
      requestAnimationFrame(pasHoogteAan);
    }
    detail.appendChild(label);
    detail.appendChild(invoer);
    veldInvoer[veld.sleutel] = invoer;
  }

  // Links
  const linksLabel = document.createElement("label");
  linksLabel.textContent = "Links";
  detail.appendChild(linksLabel);

  const linksLijst = document.createElement("div");
  linksLijst.className = "links-lijst";
  detail.appendChild(linksLijst);

  let werkLinks = (bestaand.links || []).map((l) => ({ ...l }));
  tekenLinks(werkLinks, linksLijst);

  const nieuweLinkRij = document.createElement("div");
  nieuweLinkRij.className = "nieuwe-link-rij";
  const typeKeuze = document.createElement("select");
  [
    ["url", "Link"],
    ["youtube", "YouTube"],
  ].forEach(([waarde, tekst]) => {
    const opt = document.createElement("option");
    opt.value = waarde;
    opt.textContent = tekst;
    typeKeuze.appendChild(opt);
  });
  const labelVeld = document.createElement("input");
  labelVeld.type = "text";
  labelVeld.placeholder = "Naam (bv. Presentatie H3)";
  const targetVeld = document.createElement("input");
  targetVeld.type = "text";
  targetVeld.placeholder = "https://... of ms-powerpoint:ofe|u|https://...";
  const toevoegBtn = document.createElement("button");
  toevoegBtn.type = "button";
  toevoegBtn.textContent = "+ Toevoegen";
  const nieuweLinkFout = document.createElement("div");
  nieuweLinkFout.className = "nieuwe-link-fout";
  toevoegBtn.addEventListener("click", () => {
    const doel = targetVeld.value.trim();
    if (!doel) return;
    if (!isVeiligeLinkTarget(doel)) {
      nieuweLinkFout.textContent =
        "Dit lijkt geen geldige link (gebruik bijvoorbeeld een https://-link).";
      return;
    }
    nieuweLinkFout.textContent = "";
    werkLinks.push({
      id: Math.random().toString(16).slice(2, 10),
      type: typeKeuze.value,
      label: labelVeld.value.trim() || doel,
      target: doel,
    });
    labelVeld.value = "";
    targetVeld.value = "";
    tekenLinks(werkLinks, linksLijst);
  });
  nieuweLinkRij.appendChild(typeKeuze);
  nieuweLinkRij.appendChild(labelVeld);
  nieuweLinkRij.appendChild(targetVeld);
  nieuweLinkRij.appendChild(toevoegBtn);
  detail.appendChild(nieuweLinkRij);
  detail.appendChild(nieuweLinkFout);

  function tekenLinks(links, container) {
    container.innerHTML = "";
    if (links.length === 0) {
      const leeg = document.createElement("div");
      leeg.className = "links-leeg";
      leeg.textContent = "Nog geen links.";
      container.appendChild(leeg);
      return;
    }
    links.forEach((link, idx) => {
      const rij = document.createElement("div");
      rij.className = "link-rij";
      const naam = document.createElement("span");
      naam.className = "link-naam";
      naam.textContent = link.label;
      const open = document.createElement("a");
      if (isVeiligeLinkTarget(link.target)) {
        open.href = link.target;
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = "Openen";
      } else {
        open.href = "#";
        open.className = "link-geblokkeerd";
        open.textContent = "Onveilige link geblokkeerd";
        open.addEventListener("click", (e) => e.preventDefault());
      }
      const verwijder = document.createElement("button");
      verwijder.type = "button";
      verwijder.textContent = "×";
      verwijder.addEventListener("click", () => {
        links.splice(idx, 1);
        tekenLinks(links, container);
      });
      rij.appendChild(naam);
      rij.appendChild(open);
      rij.appendChild(verwijder);
      container.appendChild(rij);
    });
  }

  // Opslaan
  const opslaanRij = document.createElement("div");
  opslaanRij.className = "opslaan-rij";
  const opslaanBtn = document.createElement("button");
  opslaanBtn.type = "button";
  opslaanBtn.className = "opslaan-knop";
  opslaanBtn.textContent = "Opslaan";
  const statusTekst = document.createElement("span");
  statusTekst.className = "opslaan-status";

  opslaanBtn.addEventListener("click", async () => {
    opslaanBtn.disabled = true;
    statusTekst.textContent = "Bezig met opslaan…";
    try {
      const nieuw = { velden: {}, links: werkLinks };
      for (const veld of LESVELDEN) {
        const waarde = veldInvoer[veld.sleutel].value;
        if (waarde.trim()) nieuw.velden[veld.sleutel] = waarde;
      }
      // Velden die niet (meer) in LESVELDEN staan niet kwijtraken
      const oudeVelden = (lesnotities[les.id] && lesnotities[les.id].velden) || {};
      for (const [k, v] of Object.entries(oudeVelden)) {
        if (!LESVELDEN.some((veld) => veld.sleutel === k) && v) nieuw.velden[k] = v;
      }
      lesnotities[les.id] = nieuw;
      // Ruim lege ingangen op zodat het bestand niet blijft groeien
      if (Object.keys(nieuw.velden).length === 0 && nieuw.links.length === 0) {
        delete lesnotities[les.id];
      }
      await slaLesnotitiesOp(les.id, `Notities bijgewerkt: ${les.summary} (${les.date})`);
      // Titel in de ingeklapte lesbalk meteen bijwerken
      const kopOnderwerp = detail.closest(".les")?.querySelector(".les-onderwerp");
      if (kopOnderwerp) zetOnderwerp(kopOnderwerp, haalVeld(lesnotities[les.id], "titel"));
      statusTekst.textContent = "Opgeslagen ✓";
      setTimeout(() => (statusTekst.textContent = ""), 2500);
    } catch (fout) {
      console.error(fout);
      statusTekst.textContent = "Mislukt: " + fout.message;
    } finally {
      opslaanBtn.disabled = false;
    }
  });

  opslaanRij.appendChild(opslaanBtn);
  opslaanRij.appendChild(statusTekst);
  detail.appendChild(opslaanRij);

  return detail;
}

// Knopje ergens in de pagina (bv. in de header) met id "token-instellen"
// kan hiermee gekoppeld worden om de sleutel handmatig te wijzigen.
document.addEventListener("DOMContentLoaded", () => {
  const knop = document.getElementById("token-instellen");
  if (knop) knop.addEventListener("click", vraagToken);
});

laadAlles();
