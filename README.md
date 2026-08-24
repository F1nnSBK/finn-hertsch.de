# **Portfolio | Finn Hertsch**

Dies ist das Quellcode-Repository für meine persönliche Portfolio-Webseite. Gebaut mit einem minimalistischen / brutalistischen Designansatz und einem Fokus auf Performance und eine saubere Codebasis.


---

## **✨ Features**

* **Modernes Frontend**: Gebaut mit **Nuxt 3** für eine schnelle und SEO-freundliche User Experience.
* **Headless Backend**: Alle Projektdaten werden dynamisch aus einer **Supabase**-Datenbank geladen.
* **Responsives Design**: Voll funktionsfähig auf allen Geräten, vom Desktop bis zum Smartphone.
* **Minimalistischer Stil**: Ein klares, auf den Inhalt fokussiertes Design, inspiriert vom Brutalismus.
* **Performant**: Optimierte Bilder mit `@nuxt/image` und serverseitiges Rendering.

---

## **🛠️ Tech Stack**

* **Framework**: [Nuxt 3](https://nuxt.com/)
* **Backend & Datenbank**: [Supabase](https://supabase.io/)
* **Styling**: [Tailwind CSS](https://tailwindcss.com/)
* **Deployment**: [Vercel](https://vercel.com/)

---

## **🚀 Lokales Setup**

Folge diesen Schritten, um das Projekt lokal zum Laufen zu bringen:

1.  **Repository klonen:**
    ```bash
    git clone [https://github.com/dein-username/dein-repo.git](https://github.com/dein-username/dein-repo.git)
    cd dein-repo
    ```

2.  **Abhängigkeiten installieren:**
    ```bash
    npm install
    ```

3.  **Umgebungsvariablen einrichten:**
    Erstelle eine `.env`-Datei im Hauptverzeichnis und füge deine Supabase-Zugangsdaten hinzu. Eine Vorlage findest du in der `.env.example`.

    **.env**
    ```env
    # Öffentliche Supabase-Daten (sicher für den Browser)
    SUPABASE_URL="DEINE_SUPABASE_PROJEKT_URL"
    SUPABASE_ANON_KEY="DEIN_PUBLIC_ANON_KEY"

    # Geheimer Service Key (nur für den Server)
    SUPABASE_KEY="DEIN_SECRET_SERVICE_ROLE_KEY"
    ```

4.  **Entwicklungsserver starten:**
    ```bash
    npm run dev
    ```

    Die Anwendung ist jetzt unter `http://localhost:3000` erreichbar.

---

## **supabase-Anbindung**

Das Projekt erwartet eine Supabase-Datenbank mit einer Tabelle namens `projects`. Du kannst diese Tabelle mit dem folgenden SQL-Befehl in deinem Supabase-Projekt erstellen:

```sql
CREATE TABLE projects (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  title TEXT,
  stack TEXT,
  short_description TEXT,
  detailed_description TEXT,
  title_image_url TEXT,
  difficulty INT,
  github TEXT,
  pdf TEXT,
  link TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```