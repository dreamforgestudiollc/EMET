# How to apply the technical-writing skill

Apply `skills/technical-writing/SKILL.md` when you write or review a controlled document, a readme, an RFC, a pull request body, a commit message, or a release note. The slash name `technical-writing` is an explicit call. It is not required.

The skill is four layers: Diátaxis, Google developer style, STE, and Global English. This page does not restate them.

The folder sits beside `skills/emet-memory/`. `.cursor-plugin/plugin.json` loads `./skills/`. `package.json` does not list `skills/` in `files`. This copy is not an npm package file and not a site page.

Document control is already written in `CHARTER.md` §7 and `templates/STANDARD.md`. Quote that wording. The standing line is ISO 9001 7.5.3 / ISO 13485 4.2.5. EMET holds no certification and claims no conformity. Nothing is deleted. Records are superseded, retired, and retained.

## When to use it

Use the skill when the text will be read again.

- A controlled document, `README.md`, or an RFC.
- A pull request body or a commit message.
- A bullet in `CHANGELOG.md`, including a release note.

Leave `CHARTER.md` §7 and `templates/STANDARD.md` as they stand. A writing pass points at them. It does not edit them.

Product UI strings are not this skill. Use the product's copy guidelines for those.

## Pull request checklist

A pull request body is a briefing. A reviewer can read it in under a minute.

- Say what changed, why it changed, and how you checked it.
- Name the real files, flags, and commands.
- Use the present tense. Say who does what. Put one thought in each sentence.
- If you mention document control, point at `CHARTER.md` §7 and `templates/STANDARD.md`. Do not add a certification claim or a conformity claim.
- If that wording did not change, write the standing line: ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged.
- Name the request you were given, and name the base commit, when the task asks for them.
- Do not paste logs, commit lists, or metric tables. Link them.
- Do not teach a tutorial inside the briefing. Link the how-to.

## Release notes checklist

A release note is one bullet in `CHANGELOG.md`.

- Put the bullet under `## Unreleased`. Newest first.
- Use a heading the file already has, such as `### Added` or `### Fixed`.
- Give the bullet one change. Name the files and the behavior.
- A private-only change says that it is private, and says what you did not publish.
- If document-control wording did not change, include the standing line: ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged.
- Do not paste a log into the bullet.

## Example

Before:

> This PR leverages several documentation updates in order to facilitate ISO compliance. It's important to note that the writing skill was added and various files were touched. Review should be simple. Full logs are pasted below.

After:

> `skills/technical-writing/SKILL.md` is the writing standard for controlled documents, pull request text, and release notes. `skills/technical-writing/README.md` says when to use it. `CHARTER.md` §7 and `templates/STANDARD.md` are unchanged. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged. The skill is not in the npm `files` list, and the site is unchanged.
