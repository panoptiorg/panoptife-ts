# Changelog

## [0.4.0](https://github.com/panoptiorg/panoptife-ts/compare/v0.3.0...v0.4.0) (2026-10-24)


### Features

* MR mode writes manifest.json for impact ([#8](https://github.com/panoptiorg/panoptife-ts/issues/8)) ([c803b15](https://github.com/panoptiorg/panoptife-ts/commit/c803b15192b4a3b55eb024c27389892dc691c6e6))

## [0.3.0](https://github.com/panoptiorg/panoptife-ts/compare/v0.2.0...v0.3.0) (2026-10-14)


### Features

* --adapter accepts a path to a .toml file, so a custom adapter can live in your own repository ([cc5346a](https://github.com/panoptiorg/panoptife-ts/commit/cc5346aad9747b2df39fa20fbaeeec494b6b9148))
* --version ([cc5346a](https://github.com/panoptiorg/panoptife-ts/commit/cc5346aad9747b2df39fa20fbaeeec494b6b9148))


### Bug Fixes

* a missing repo, a file or a repo with no source files is an error instead of an empty CGF ([cc5346a](https://github.com/panoptiorg/panoptife-ts/commit/cc5346aad9747b2df39fa20fbaeeec494b6b9148))
* an unknown adapter lists the shipped adapters; no stack trace for user errors ([cc5346a](https://github.com/panoptiorg/panoptife-ts/commit/cc5346aad9747b2df39fa20fbaeeec494b6b9148))
* name an unknown flag (with a suggestion) or a missing option, exit 2; full usage only for --help ([cc5346a](https://github.com/panoptiorg/panoptife-ts/commit/cc5346aad9747b2df39fa20fbaeeec494b6b9148))

## [0.2.0](https://github.com/panoptiorg/panoptife-ts/compare/v0.1.1...v0.2.0) (2026-10-08)


### Features

* React and Next.js support, HTTP routes and client calls ([#4](https://github.com/panoptiorg/panoptife-ts/issues/4)) ([11379c3](https://github.com/panoptiorg/panoptife-ts/commit/11379c39c894b3466c2bd72c9f9cea12d0e1cf9e))

## [0.1.1](https://github.com/panoptiorg/panoptife-ts/compare/v0.1.0...v0.1.1) (2026-10-07)


### Bug Fixes

* detect SvelteKit endpoints by route file and export ([#2](https://github.com/panoptiorg/panoptife-ts/issues/2)) ([189d6e7](https://github.com/panoptiorg/panoptife-ts/commit/189d6e7b8814278e6ee90ced001e5eb70db3bc03))
* keep #private, quoted and numeric class method names ([189d6e7](https://github.com/panoptiorg/panoptife-ts/commit/189d6e7b8814278e6ee90ced001e5eb70db3bc03))

## 0.1.0 (2026-10-04)


### Features

* initial release ([b9e4a3e](https://github.com/panoptiorg/panoptife-ts/commit/b9e4a3e8b605bcc00afe5168e31bd79be66005d5))
