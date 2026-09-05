// Leest data/rooster.json (hetzelfde domein als de site zelf, dus geen
// CORS-probleem) en toont de lessen gegroepeerd per dag.
async function laadRooster() {
  const container = document.getElementById("rooster");
  try {
    const response = await fetch("data/rooster.json");
    if (!response.ok) throw new Error("Bestand niet gevonden");
    const data = await response.json();
    toonRooster(data.lessons, container);
  } catch (fout) {
    container.textContent =
      "Kon het rooster nog niet laden. Is de GitHub Action al een keer gedraaid?";
    console.error(fout);
  }
}

function toonRooster(lessen, container) {
  container.innerHTML = "";

  const perDag = {};
  for (const les of lessen) {
    if (!perDag[les.date]) perDag[les.date] = [];
    perDag[les.date].push(les);
  }

  const datums = Object.keys(perDag).sort();
  if (datums.length === 0) {
    container.textContent = "Nog geen lessen gevonden.";
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

    for (const les of perDag[datum]) {
      const item = document.createElement("li");
      item.className = "les" + (les.cancelled ? " vervallen" : les.changed ? " gewijzigd" : "");

      const tijd = document.createElement("span");
      tijd.className = "les-tijd";
      tijd.textContent = `${les.start}\u2013${les.end}`;

      const titel = document.createElement("span");
      titel.className = "les-titel";
      titel.textContent = les.summary;

      item.appendChild(tijd);
      item.appendChild(titel);

      if (les.cancelled) {
        const label = document.createElement("span");
        label.className = "les-label";
        label.textContent = "vervallen";
        item.appendChild(label);
      } else if (les.changed) {
        const label = document.createElement("span");
        label.className = "les-label";
        label.textContent = "gewijzigd";
        item.appendChild(label);
      }

      lijst.appendChild(item);
    }

    container.appendChild(lijst);
  }
}

laadRooster();