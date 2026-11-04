# ram-inspector

En Claude Code-mod, der viser et panel ved siden af chatten med, hvilke Claude Code-sessioner og -processer der bruger RAM på din computer. Herfra kan du sætte en session (eller en enkelt underproces, fx et build) på pause, fortsætte den igen eller stoppe den.

## Hvad den kan

- **Overblik:** systemets RAM-forbrug, hvor meget Claude samlet bruger, og en liste over sessioner sorteret efter RAM. Hver session kan foldes ud, så du ser dens underprocesser (MCP-servere, shells, builds, tests …). Sessionen, du sidder i, er markeret "denne session" og kan ikke sættes på pause (så ville panelet fryse).
- **Pause / Fortsæt / Stop** for en hel session eller en enkelt proces. Stop kræver et ekstra klik.
- **Guard** (slået fra som standard): når RAM-forbruget når 85 %, sætter den den nyeste tunge session (mindst 300 MB) på pause, og når forbruget er nede på 70 %, fortsætter den sessionen igen. Den ældste session får altid lov at køre. Slår du guarden fra, eller lukker du sessionen, fortsætter den det, den selv har sat på pause.
- `/ram` åbner panelet og skriver et kort overblik i chatten.

Bemærk: pause stopper CPU-forbruget og forhindrer, at processen bruger mere RAM, men den RAM, processen allerede har, bliver ikke frigivet (systemet kan dog flytte den til swap). Det gør Stop. En session, der har ligget på pause længe, kan få en timeout på sit API-kald, når den fortsætter igen. Claude Code prøver normalt igen af sig selv.

Kør kun guarden i én session ad gangen.

## Installation

Ved prompten i en Claude Code-terminal:

```
/plugin install ram-inspector --marketplace Vitrinem/claude-ram
```

Fra en shell:

```bash
claude plugin install ram-inspector --marketplace Vitrinem/claude-ram
```

I desktop-appen, hvor `/plugin` ikke virker: klik på + ved siden af promptfeltet, vælg Plugins, så Add marketplace med `Vitrinem/claude-ram`, og derefter Add plugin.

Repository'et er privat. Installationen virker derfor kun for folk med læseadgang på GitHub, hvis computer allerede har GitHub-login sat op (en SSH-nøgle, eller `gh auth login` og derefter `gh auth setup-git`).

## Platforme

macOS og Linux (`ps`, `kill -STOP/-CONT`) og Windows (PowerShell; pause sker via `NtSuspendProcess`). På Windows vises intet CPU-forbrug, og listen opdateres hvert 6. sekund i stedet for hvert 3.
