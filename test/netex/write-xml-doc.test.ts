import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeXmlDocToFile } from '../../src/netex/utils';
import { canonical, parse } from './xml-test-utils';

const SOURCE =
    '<Root xmlns="http://www.netex.org.uk/netex" xmlns:gml="http://www.opengis.net/gml/3.2" id="r &amp; 1">' +
    '<Lines><Line id="L1"><Name>  Route &amp; &lt;1&gt;  </Name><Empty/><Blank> </Blank>' +
    '<Description>first\n  second\n</Description><gml:pos>60.1 24.9</gml:pos></Line></Lines>' +
    '<Mixed>a<b>x</b>c</Mixed></Root>';

describe('writeXmlDocToFile', () => {
    let dir: string;

    const write = (format: boolean): string => {
        writeXmlDocToFile(parse(SOURCE), dir, 'out.xml', format);
        return fs.readFileSync(path.join(dir, 'out.xml'), 'utf8');
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs2netex-test-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes the declaration once at the start and uses LF line endings only', () => {
        const output = write(true);

        assert.ok(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Root '));
        assert.equal(output.match(/<\?xml /g)?.length, 1);
        assert.equal(output.includes('\r'), false);
        assert.equal(output.endsWith('\n'), false);
    });

    it('indents the output', () => {
        const output = write(true);

        assert.ok(output.includes('\n  <Lines>\n    <Line id="L1">\n      <Name>'));
        assert.ok(output.includes('\n    </Line>\n  </Lines>\n'));
    });

    it('preserves leaf text exactly', () => {
        const output = write(true);

        assert.ok(output.includes('<Name>  Route &amp; &lt;1&gt;  </Name>'));
        assert.ok(output.includes('<Blank> </Blank>'));
        assert.ok(output.includes('<Description>first\n  second\n</Description>'));
        assert.ok(output.includes('<Mixed>a<b>x</b>c</Mixed>'));
    });

    it('is canonically equal to the unformatted output', () => {
        assert.equal(canonical(write(true)), canonical(write(false)));
    });

    it('does not indent when format is false', () => {
        const output = write(false);

        assert.equal(output.includes('\n  <'), false);
        assert.ok(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Root '));
        assert.ok(output.includes('<Lines><Line id="L1"><Name>'));
    });
});
