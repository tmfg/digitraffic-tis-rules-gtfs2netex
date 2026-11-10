import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Element, XMLSerializer } from '@xmldom/xmldom';
import { writeAllStopsStreaming } from '../../src/netex/writestops';
import { canonical, parse } from './xml-test-utils';

const NS = 'xmlns="http://www.netex.org.uk/netex"';

const STOP_PLACES = [
    `<StopPlace ${NS} id="FI:StopPlace:1" version="1"><Name>Asema &amp; Co</Name><Description>  padded  </Description>` +
        '<Centroid><Location><Longitude>24.9</Longitude><Latitude>60.1</Latitude></Location></Centroid>' +
        '<quays><Quay id="FI:Quay:1"><Name>Laituri ä</Name></Quay><Quay id="FI:Quay:2"/></quays></StopPlace>',
    `<StopPlace ${NS} id="FI:StopPlace:2" version="1"><Name>Toinen</Name></StopPlace>`,
];

// The writer returns before the stream is flushed, so wait until the footer is on disk.
async function readWhenComplete(file: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
        if (fs.existsSync(file)) {
            const text = fs.readFileSync(file, 'utf8');
            if (text.endsWith('</PublicationDelivery>\n')) {
                return text;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('stops file was not completed');
}

describe('writeAllStopsStreaming', () => {
    let dir: string;
    let output: string;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs2netex-stops-'));
        const map: Record<string, Element> = Object.fromEntries(
            STOP_PLACES.map((xml, i) => [`sp${i}`, parse(xml).documentElement as Element]),
        );

        writeAllStopsStreaming(map, dir, 'TEST');

        output = await readWhenComplete(path.join(dir, 'TEST_all_stops.xml'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('puts each StopPlace child on its own line below the 8-space StopPlace indentation', () => {
        assert.ok(
            output.includes(
                [
                    `        <StopPlace ${NS} id="FI:StopPlace:1" version="1">`,
                    '          <Name>Asema &amp; Co</Name>',
                    '          <Description>  padded  </Description>',
                    '          <Centroid>',
                    '            <Location>',
                    '              <Longitude>24.9</Longitude>',
                    '              <Latitude>60.1</Latitude>',
                    '            </Location>',
                    '          </Centroid>',
                    '          <quays>',
                    '            <Quay id="FI:Quay:1">',
                    '              <Name>Laituri ä</Name>',
                    '            </Quay>',
                    '            <Quay id="FI:Quay:2"/>',
                    '          </quays>',
                    '        </StopPlace>',
                    `        <StopPlace ${NS} id="FI:StopPlace:2" version="1">`,
                    '          <Name>Toinen</Name>',
                    '        </StopPlace>',
                    '      </stopPlaces>',
                ].join('\n') + '\n',
            ),
        );
    });

    it('leaves the header and footer as they were', () => {
        assert.ok(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<PublicationDelivery '));
        assert.ok(output.includes('\n      <stopPlaces>\n        <StopPlace '));
        assert.ok(output.endsWith('      </stopPlaces>\n    </SiteFrame>\n  </dataObjects>\n</PublicationDelivery>\n'));
        assert.equal(output.match(/<\?xml /g)?.length, 1);
    });

    it('uses LF line endings only', () => {
        assert.equal(output.includes('\r'), false);
    });

    it('is canonically equal to the unformatted StopPlaces', () => {
        const written = Array.from(parse(output).getElementsByTagName('StopPlace')).map((sp) =>
            canonical(new XMLSerializer().serializeToString(sp)),
        );

        assert.deepEqual(
            written,
            STOP_PLACES.map((xml) => canonical(xml)),
        );
    });
});
