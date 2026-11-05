import assert from 'node:assert/strict';
import { XMLSerializer } from '@xmldom/xmldom';
import { indentDocument, MAX_INDENTED_CHILDREN } from '../../src/netex/xml-indent';
import { parse } from './xml-test-utils';

function indent(xml: string): string {
    const doc = parse(xml);
    indentDocument(doc);
    return new XMLSerializer().serializeToString(doc);
}

describe('indentDocument', () => {
    it('puts each child of an element-only parent on its own line, two spaces per level', () => {
        const xml = '<A><B><C/><D/></B><E><F><G/></F></E></A>';

        assert.equal(
            indent(xml),
            [
                '<A>',
                '  <B>',
                '    <C/>',
                '    <D/>',
                '  </B>',
                '  <E>',
                '    <F>',
                '      <G/>',
                '    </F>',
                '  </E>',
                '</A>',
            ].join('\n'),
        );
    });

    it('keeps leaf text inline and exactly as it was', () => {
        const xml = '<A><Name>  padded  </Name><Blank> </Blank><Multi>line1\n  line2\n</Multi></A>';

        assert.equal(
            indent(xml),
            ['<A>', '  <Name>  padded  </Name>', '  <Blank> </Blank>', '  <Multi>line1\n  line2\n</Multi>', '</A>'].join('\n'),
        );
    });

    it('leaves empty elements as self-closing tags', () => {
        assert.equal(indent('<A><Empty/><B><Empty/></B></A>'), '<A>\n  <Empty/>\n  <B>\n    <Empty/>\n  </B>\n</A>');
        assert.equal(indent('<Empty/>'), '<Empty/>');
    });

    it('does not touch an element that has mixed content', () => {
        const xml = '<A><P>text <b>bold</b> more<i><x/></i></P><Q/></A>';

        assert.equal(indent(xml), '<A>\n  <P>text <b>bold</b> more<i><x/></i></P>\n  <Q/>\n</A>');
    });

    it('does not touch an element that has whitespace text between its children', () => {
        const xml = '<A><P><x/> <y/></P></A>';

        assert.equal(indent(xml), '<A>\n  <P><x/> <y/></P>\n</A>');
    });

    it('does not touch an element that has a comment, CDATA section or processing instruction child', () => {
        assert.equal(indent('<A><P><!--c--><x/></P></A>'), '<A>\n  <P><!--c--><x/></P>\n</A>');
        assert.equal(indent('<A><P><x/><![CDATA[<raw>]]></P></A>'), '<A>\n  <P><x/><![CDATA[<raw>]]></P>\n</A>');
        assert.equal(indent('<A><P><?pi data?><x/></P></A>'), '<A>\n  <P><?pi data?><x/></P>\n</A>');
    });

    it('keeps escaping in text and attributes, and non-ASCII text', () => {
        const xml = '<A attr="a &amp; b &lt; c &quot;q&quot;"><T>x &amp; y &lt; z &gt; w</T><U>Ääkköset 😀 ñ</U></A>';

        assert.equal(
            indent(xml),
            [
                '<A attr="a &amp; b &lt; c &quot;q&quot;">',
                '  <T>x &amp; y &lt; z &gt; w</T>',
                '  <U>Ääkköset 😀 ñ</U>',
                '</A>',
            ].join('\n'),
        );
    });

    it('declares namespaces only on the root', () => {
        const xml =
            '<PublicationDelivery xmlns="http://www.netex.org.uk/netex" xmlns:gml="http://www.opengis.net/gml/3.2" version="1.0">' +
            '<dataObjects><gml:pos srsName="EPSG:4326">1 2</gml:pos></dataObjects></PublicationDelivery>';

        const result = indent(xml);

        assert.equal(result.match(/xmlns/g)?.length, 2);
        assert.ok(result.startsWith('<PublicationDelivery xmlns="http://www.netex.org.uk/netex" xmlns:gml='));
        assert.ok(result.includes('\n    <gml:pos srsName="EPSG:4326">1 2</gml:pos>\n'));
    });

    it('does not add a trailing newline', () => {
        assert.ok(!indent('<A><B/></A>').endsWith('\n'));
    });

    describe('element with very many children', () => {
        const item = '<i><j/></i>';

        it('leaves an element with more children than the limit, and its subtree, unindented', () => {
            const content = item.repeat(MAX_INDENTED_CHILDREN + 1);
            const xml = `<A><Big>${content}</Big><Other><x/></Other></A>`;

            assert.equal(indent(xml), `<A>\n  <Big>${content}</Big>\n  <Other>\n    <x/>\n  </Other>\n</A>`);
        });

        it('still indents an element with exactly the limit number of children', function () {
            this.timeout(20000);
            const xml = `<A><Big>${item.repeat(MAX_INDENTED_CHILDREN)}</Big></A>`;

            const result = indent(xml);

            assert.ok(result.startsWith('<A>\n  <Big>\n    <i>\n      <j/>\n    </i>\n    <i>'));
            assert.ok(result.endsWith('    </i>\n  </Big>\n</A>'));
        });

        it('indents an element with a huge number of children quickly', function () {
            this.timeout(10000);
            const xml = `<A><Big>${'<i/>'.repeat(40000)}</Big></A>`;

            const start = Date.now();
            const result = indent(xml);
            const elapsed = Date.now() - start;

            assert.equal(result, `<A>\n  <Big>${'<i/>'.repeat(40000)}</Big>\n</A>`);
            assert.ok(elapsed < 2000, `took ${elapsed} ms`);
        });
    });
});
