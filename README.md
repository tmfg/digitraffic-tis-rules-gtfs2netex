###### Digitraffic / Travel Information Services

# GTFS to NeTEx Nordic Converter Rule

Standalone module for converting [GTFS][gtfs] to [NeTEx Nordic][netex-nordic]. Works only with local files to keep things simple.

This module is implemented as a straightforward [npm] based project.

_Rule_ in name refers to [Fintraffic TIS VACO][ft-tis-vaco]'s architectural concept of a standalone executable conversion rule. This is
not important if you just want to use this in your own project.

## Usage

### Install/update dependencies

```shell
npm install
```

### Build
```shell
npm run build
```

### Run

```shell
npm run convert -- --gtfs /path/to/gtfs-file.zip --netex /path/to/netex-directory
```

---

Copyright Fintraffic 2023-2024. Licensed under the EUPL-1.2 or later.

[gtfs]: https://gtfs.org/
[netex-nordic]: https://enturas.atlassian.net/wiki/spaces/PUBLIC/pages/728891481/Nordic+NeTEx+Profile
[ft-tis-vaco]: https://www.fintraffic.fi/fi/digitaalisetpalvelut/fintrafficin-datapalvelut/liikkumisen-tietopalvelut/validointi-ja-konvertointipalvelu
