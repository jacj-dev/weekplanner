// ---------------------------------------------------------------------
// Instellingen -- pas REPO aan als je dit ooit in een andere repository
// gebruikt.
// ---------------------------------------------------------------------
const REPO = "jacj-dev/weekplanner";
const BRANCH = "main";
const NOTITIES_PATH = "data/lesnotities.json";
const TOKEN_KEY = "weekplanner_gh_token";

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

// Staat alleen http(s)/mailto-links en relatieve paden (bv. "materialen/x.pptx")
// toe als link-doel. Blokkeert bv. "javascript:...", zodat een kwaadwillend
// geschreven link nooit script kan uitvoeren als iemand er per ongeluk op klikt.
function isVeiligeLinkTarget(target) {
  const t = (target || "").trim();
  if (!t) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return true; // geen "schema:" -> relatief pad
  return /^(https?|mailto):/i.test(t);
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
  titel.textContent = les.summary;

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

  const bestaand = lesnotities[les.id] || { notitie: "", links: [] };

  // Notitieveld
  const notitieLabel = document.createElement("label");
  notitieLabel.textContent = "Notitie";
  const notitieVeld = document.createElement("textarea");
  notitieVeld.className = "les-notitieveld";
  notitieVeld.value = bestaand.notitie || "";
  detail.appendChild(notitieLabel);
  detail.appendChild(notitieVeld);

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
  ["bestand", "youtube", "url"].forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t === "bestand" ? "Bestand in repo" : t === "youtube" ? "YouTube" : "Andere link";
    typeKeuze.appendChild(opt);
  });
  const labelVeld = document.createElement("input");
  labelVeld.type = "text";
  labelVeld.placeholder = "Naam (bv. Presentatie H3)";
  const targetVeld = document.createElement("input");
  targetVeld.type = "text";
  targetVeld.placeholder = "materialen/bestand.pptx of https://...";
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
        "Dit lijkt geen geldige link (gebruik een https://-link of een pad zoals materialen/bestand.pptx).";
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
      lesnotities[les.id] = { notitie: notitieVeld.value, links: werkLinks };
      // Ruim lege ingangen op zodat het bestand niet blijft groeien
      if (!lesnotities[les.id].notitie && lesnotities[les.id].links.length === 0) {
        delete lesnotities[les.id];
      }
      await slaLesnotitiesOp(les.id, `Notities bijgewerkt: ${les.summary} (${les.date})`);
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
