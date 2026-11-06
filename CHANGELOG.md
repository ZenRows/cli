# Changelog

## [1.13.1](https://github.com/ZenRows/cli/compare/v1.13.0...v1.13.1) (2026-11-06)


### Behaviour Changes

* **fetch:** the default --timeout is 200 s instead of 120 s, so a slow request gets the API's full 3 minutes ([07dc59f](https://github.com/ZenRows/cli/commit/07dc59ffecab780e3bfd78ceeee939c14c3b9891))


### Bug Fixes

* **fetch:** wait past the API's 3-minute budget before giving up ([07dc59f](https://github.com/ZenRows/cli/commit/07dc59ffecab780e3bfd78ceeee939c14c3b9891))

## [1.13.0](https://github.com/ZenRows/cli/compare/v1.12.0...v1.13.0) (2026-11-06)


### Features

* **fetch:** add --retries to fetch and extract, off by default, following the shared retry policy ([ea4d557](https://github.com/ZenRows/cli/commit/ea4d5578fef496d0a01123259c139dd386ee55a1))

## [1.12.0](https://github.com/ZenRows/cli/compare/v1.11.0...v1.12.0) (2026-10-30)


### Features

* **crawl:** get notified by webhook when a crawl starts, completes, stops or fails ([#75](https://github.com/ZenRows/cli/issues/75)) ([d71df97](https://github.com/ZenRows/cli/commit/d71df972a6a9e29d619d5c8a829022c6156530ea))


### Bug Fixes

* **batch:** stop a wait before a back-off that ends on its --timeout ([#76](https://github.com/ZenRows/cli/issues/76)) ([090c75f](https://github.com/ZenRows/cli/commit/090c75f4fabbfc19f86c2c1c6c79354175677636))

## [1.11.0](https://github.com/ZenRows/cli/compare/v1.10.0...v1.11.0) (2026-10-27)


### Features

* **extract:** steer prepare callers to send several example URLs of one page type ([#72](https://github.com/ZenRows/cli/issues/72)) ([c8dc644](https://github.com/ZenRows/cli/commit/c8dc644d7b04d6a59ae8a72900961438e3b76b6f))

## [1.10.0](https://github.com/ZenRows/cli/compare/v1.9.0...v1.10.0) (2026-10-23)


### Features

* **signup:** agents could not get past the signup question, which only surfaced as a raw HTTP 428 body ([#73](https://github.com/ZenRows/cli/issues/73)) ([eac6f7a](https://github.com/ZenRows/cli/commit/eac6f7a625fb51ab081f282a428966f187493cb6))


### Bug Fixes

* **skills:** name the local storage tools the MCP server registers since 2.15.0 ([#70](https://github.com/ZenRows/cli/issues/70)) ([eb61828](https://github.com/ZenRows/cli/commit/eb61828df42df32bf1b6c497caf22185ed6ec545))

## [1.9.0](https://github.com/ZenRows/cli/compare/v1.8.0...v1.9.0) (2026-10-20)


### Features

* **extract:** remove the autoparse fallback and add zenrows extract prepare ([#47](https://github.com/ZenRows/cli/issues/47)) ([88a33d6](https://github.com/ZenRows/cli/commit/88a33d67f0c6c94accde1061f9ea10e7911f047b))

## [1.8.0](https://github.com/ZenRows/cli/compare/v1.7.0...v1.8.0) (2026-10-20)


### Features

* **batch:** agents could not recover, inspect or manage batch jobs from the CLI ([#67](https://github.com/ZenRows/cli/issues/67)) ([a850ea4](https://github.com/ZenRows/cli/commit/a850ea437b013cf10e584e6b87366b94037ae81b))

## [1.7.0](https://github.com/ZenRows/cli/compare/v1.6.2...v1.7.0) (2026-10-18)


### Features

* **account:** claim links expire after 30 days and accounts get claimed in the browser, so refresh the stored link and stop offering it once claimed ([#65](https://github.com/ZenRows/cli/issues/65)) ([ded5602](https://github.com/ZenRows/cli/commit/ded5602caa300aa288f6532a27abd38de83362a1))

## [1.6.2](https://github.com/ZenRows/cli/compare/v1.6.1...v1.6.2) (2026-10-16)


### Bug Fixes

* **crawl:** say a crawl with nothing new to follow completes, so users stop chasing their patterns ([#50](https://github.com/ZenRows/cli/issues/50)) ([0301d47](https://github.com/ZenRows/cli/commit/0301d47036a8a8dacd7549c1aacf0f3c29be5afe))

## [1.6.1](https://github.com/ZenRows/cli/compare/v1.6.0...v1.6.1) (2026-10-16)


### Bug Fixes

* **crawl:** exit 1 when a crawl stops because credits ran out ([#49](https://github.com/ZenRows/cli/issues/49)) ([8661688](https://github.com/ZenRows/cli/commit/8661688d97029f0ab8ff18fe1a0ce5cb54f6b416))

## [1.6.0](https://github.com/ZenRows/cli/compare/v1.5.5...v1.6.0) (2026-10-16)


### Features

* **crawl:** return each page as Markdown, and choose how a crawl finds URLs ([#44](https://github.com/ZenRows/cli/issues/44)) ([6cd34a2](https://github.com/ZenRows/cli/commit/6cd34a2de8ed2c7a5fcfedc4ecddc8f1b8480a81))


### Bug Fixes

* **batch:** point an inactive subscription to Billing, not to re-login ([#45](https://github.com/ZenRows/cli/issues/45)) ([58a1229](https://github.com/ZenRows/cli/commit/58a12297728690af3d45315fe74a4b6438e1935f))

## [1.5.5](https://github.com/ZenRows/cli/compare/v1.5.4...v1.5.5) (2026-10-15)


### Bug Fixes

* **release:** npm rejected the 1.5.4 publish because the repository URL casing did not match the provenance ([#54](https://github.com/ZenRows/cli/issues/54)) ([f778864](https://github.com/ZenRows/cli/commit/f7788649d7f834ba01b88e1bfe45dfd0cb67518d))

## [1.5.4](https://github.com/ZenRows/cli/compare/v1.5.3...v1.5.4) (2026-10-15)


### Bug Fixes

* **skills:** strict YAML parsers skipped the crawl skill over an unquoted colon ([#51](https://github.com/ZenRows/cli/issues/51)) ([fdd9eaa](https://github.com/ZenRows/cli/commit/fdd9eaa839f041c27b6f7f8d1ef97f183983efb9))

Releases before 1.5.4 are on [GitHub Releases](https://github.com/ZenRows/cli/releases).
