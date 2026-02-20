import _ from "lodash";
import {Agency, Calendar, CalendarDate, Gtfs, Route, Stop, StopTime, Trip, FeedInfo, Translation} from "../utils/gtfs-types";
import * as fs from 'fs';
import { rootLogger } from "../utils/logger";
import * as xpath from 'xpath';
import { Document, Element, XMLSerializer, Node as XmlNode } from '@xmldom/xmldom';
import xmlFormat from 'xml-formatter';
import {DateTime} from "ts-luxon";

const log = rootLogger.child({src: 'utils.ts'});

interface Stats {
    Lines: number,
    StopPlaces: number,
    Quays: number,
    JourneyPatterns: number,
    ServiceJourneys: number,
}

function findAgencyForId(gtfs: Gtfs, agencyId: string): Agency {
    if (gtfs.agency.length === 1) {
        return gtfs.agency[0]; // trivial case, only one agency, and in that case agencyId is optional
    }
    return gtfs.agency.find((a) => a.agency_id === agencyId) as Agency;
}

function findTripsForRouteId(gtfs: Gtfs, routeId: string): Trip[] {
    return gtfs.trips.filter((t) => t.route_id === routeId) as Trip[];
}

// Prepare the index outside the function (only once for the entire GTFS dataset)
function indexStopsById(gtfs: Gtfs): { [stop_id: string]: Stop } {
    const stopsById: { [stop_id: string]: Stop } = {};

    for (const stop of gtfs.stops) {
        stopsById[stop.stop_id] = stop;
    }

    return stopsById;
}

function findStopsForTrips(gtfs: Gtfs, stopsById: { [stop_id: string]: Stop }, trips: Trip[], stoptimesIndex: { [trip_id: string]: StopTime[] }): Stop[] {
    // Create a Set to store unique stop IDs encountered
    const stopIdSet = new Set<string>();
    for (const trip of trips) {
        const stopTimesForTrip = stoptimesIndex[trip.trip_id];
        if (stopTimesForTrip) {
            for (const stopTime of stopTimesForTrip) {
                stopIdSet.add(stopTime.stop_id);
            }
        }
    }
    // Map the unique stop IDs to their corresponding Stop objects
    return Array.from(stopIdSet).map((stopId) => stopsById[stopId]).filter((s) => s) as Stop[];
}

function findCalendarsForTrips(gtfs: Gtfs, trips: Trip[]): Calendar[] {
    let serviceIds = trips.map((t) => t.service_id);
    serviceIds = Array.from(new Set(serviceIds));
    return gtfs.calendar.filter((c) => serviceIds.includes(c.service_id)) as Calendar[];
}

function findCalendarDatesForTrips(gtfs: Gtfs, trips: Trip[]): CalendarDate[] {
    let serviceIds = trips.map((t) => t.service_id);
    serviceIds = Array.from(new Set(serviceIds));
    return gtfs.calendar_dates.filter((cd) => serviceIds.includes(cd.service_id)) as CalendarDate[];
}

// Prepare the index outside the function (only once for the entire GTFS dataset)
function indexStopTimesByTripId(gtfs: Gtfs): { [trip_id: string]: StopTime[] } {
    const stopTimesByTripId: { [trip_id: string]: StopTime[] } = {};

    for (const stopTime of gtfs.stop_times) {
        const tripId = stopTime.trip_id;
        if (!stopTimesByTripId.hasOwnProperty(tripId)) {
            stopTimesByTripId[tripId] = [];
        }
        stopTimesByTripId[tripId].push(stopTime);
    }

    return stopTimesByTripId;
}

// Use the index to find stop times for a specific trip id
function findStopTimesForTripId(stopTimesByTripId: { [trip_id: string]: StopTime[] }, tripId: string): StopTime[] {
    const unsorted = stopTimesByTripId[tripId] || [];
    return unsorted.sort((a, b) => a.stop_sequence - b.stop_sequence);
}

function getNetexLineId(gtfsRoute: Route, agency: Agency, feedInfo: FeedInfo): string {
    const codeSpace = getCodeSpaceForAgency(agency, feedInfo);
    return codeSpace + 'Line' + ':' + gtfsRoute.route_id;
}

function getNetexOperatorId(gtfsAgency: Agency): string {
    return 'FSR:' + 'Operator' + ':' + _.camelCase(gtfsAgency.agency_name);
}

function getTransportMode(gtfsRouteType: number): string {
    // Map GTFS route types to NeTEx transport modes
    const gtfsToNetexTransportMode: Record<number, string> = {
        0: 'tram',
        1: 'metro',
        2: 'rail',
        102: 'rail',
        103: 'rail',
        109: 'rail',
        3: 'bus',
        700: 'bus',
        701: 'bus',
        702: 'bus',
        703: 'bus',
        704: 'bus',
        710: 'bus',
        711: 'bus',
        712: 'bus',
        713: 'bus',
        714: 'bus',
        715: 'bus',
        900: 'tram',
        4: 'water',
        5: 'cablecar',
        6: 'gondola',
        7: 'funicular',
        1100: 'air',
        1101: 'air',
        1102: 'air',
        1103: 'air',
        1104: 'air',
        1105: 'air',
        1106: 'air',
        1107: 'air',
        1108: 'air',
        1109: 'air',
        1110: 'air',
        1111: 'air',
        1112: 'air',
        1113: 'air',
        1114: 'air'
    };
    const mode = gtfsToNetexTransportMode[gtfsRouteType];
    if (mode) {
        return mode;
    }
    log.warn('Unknown GTFS route type: ' + gtfsRouteType);
    return 'other';
}

function getStopPlaceType(gtfsRouteType: number): string {
    const mode = getTransportMode(gtfsRouteType);
    if (mode === 'tram') {
        return 'onstreetTram';
    }
    if (mode === 'metro') {
        return 'metroStation';
    }
    if (mode === 'rail') {
        return 'railStation';
    }
    if (mode === 'bus') {
        return 'onstreetBus';
    }
    if (mode === 'water') {
        return 'harbourPort';
    }
    if (mode === 'cablecar' || mode === 'gondola' || mode === 'funicular') {
        return 'liftStation';
    }
    if (mode === 'air') {
        return 'airport';
    }
    log.warn('Unknown GTFS route type: ' + gtfsRouteType);
    return '';
}

const CODESPACE_FROM_FEEDINFO = true; //process.env.CODESPACE_FROM_FEEDINFO === 'true';

function getCodeSpaceForAgency(gtfsAgency: Agency, feedInfo: FeedInfo): string {
    if (CODESPACE_FROM_FEEDINFO) {
        // Use the first 3 letters of feed_publisher_name as codespace
        const publisherName = feedInfo?.feed_publisher_name || 'OTH';
        return _.camelCase(publisherName).slice(0, 3).toUpperCase() + ':';
    }
    let cs = getCodeSpaceForAgencyByUrl(gtfsAgency.agency_fare_url);
    if (_.isEmpty(cs)) {
        cs = 'OTH:'
    }
    return cs;
}

function getCodeSpaceForAgencyByUrl(url: string): string {
    if (!url || _.isEmpty(url)) {
        return '';
    }
    if (url.includes('matkahuolto.fi')) {
        return 'MAT:';
    }
    if (url.includes('vr.fi')) {
        return 'VRG:';
    }
    if (url.includes('waltti')) {
        return 'WAL:';
    }
    if (url.includes('hsl.fi')) {
        return 'HSL:';
    }
    if (url.includes('tampere.fi')) {
        return 'NYS:';
    }
    if (url.includes('foli.fi')) {
        return 'FOL:';
    }
    if (url.includes('oulunjoukkoliikenne')) {
        return 'OSL:';
    }
    if (url.includes('jyvaskyla')) {
        return 'LIN:';
    }
    return '';
}

function addAccessibilityAssessment(
    parent: Element,
    wcb: string,
    cs: string,
    parentId: string
): void {
    let value = 'unknown';

    // Map wheelchair boarding values to accessibility values
    if (wcb === '1') {
        value = 'partial';
    } else if (wcb === '2') {
        value = 'false';
    }

    const doc = parent.ownerDocument!;

    // Create the AccessibilityAssessment element
    const accessibilityAssessment = doc.createElement('AccessibilityAssessment');
    accessibilityAssessment.setAttribute('version', '1');
    accessibilityAssessment.setAttribute('id', `${cs}AccessibilityAssessment:${parentId}`);

    // Create and append MobilityImpairedAccess element
    const mobilityImpairedAccess = doc.createElement('MobilityImpairedAccess');
    mobilityImpairedAccess.textContent = value;
    accessibilityAssessment.appendChild(mobilityImpairedAccess);

    // Create limitations -> AccessibilityLimitation elements
    const limitations = doc.createElement('limitations');
    const accessibilityLimitation = doc.createElement('AccessibilityLimitation');

    const wheelchairAccess = doc.createElement('WheelchairAccess');
    wheelchairAccess.textContent = value;
    accessibilityLimitation.appendChild(wheelchairAccess);

    const stepFreeAccess = doc.createElement('StepFreeAccess');
    stepFreeAccess.textContent = value;
    accessibilityLimitation.appendChild(stepFreeAccess);

    limitations.appendChild(accessibilityLimitation);
    accessibilityAssessment.appendChild(limitations);

    // Append AccessibilityAssessment to the parent element
    parent.appendChild(accessibilityAssessment);
}

// Function to generate a translations map
function getTranslationsMap(
    translations: Translation[],
    table_name: string,
    field_name: string
): Record<string, Record<string, string>> {
    const translationsMap: Record<string, Record<string, string>> = {};

    // Populate the translations map with Translation objects
    translations.forEach(translation => {
        const {
            table_name: translationTableName,
            field_name: translationFieldName,
            language,
            translation: translatedName,
            record_id
        } = translation;

        // Check if it's a translation for the specified table and field, and has a record_id
        if (translationTableName === table_name && translationFieldName === field_name && record_id) {
            if (!translationsMap[record_id]) {
                translationsMap[record_id] = {};
            }
            translationsMap[record_id][language] = translatedName;
        }
    });

    return translationsMap;
}

function writeXmlDocToFile(xmlDoc: Document, outputPath: string, filename: string, format: boolean = true): void {
    const xmlSerializer = new XMLSerializer();
    let xmlString = xmlSerializer.serializeToString(xmlDoc);

    xmlString = `<?xml version="1.0" encoding="UTF-8"?>\n` + xmlString;
    if (format) {
        xmlString = xmlFormat(xmlString, {collapseContent: true, indentation: '  '});
    }

    const filePath = `${outputPath}/${filename}`;

    // Ensure the output directory exists
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }

    // Write the prettified XML string to the file
    fs.writeFileSync(filePath, xmlString, 'utf8');
}

function writeStatsToFile(stats: Stats, outputPath: string, filename: string): void {
    const statsString = JSON.stringify(stats, null, 2);
    const filePath = `${outputPath}/${filename}`;

    // Ensure the output directory exists
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, {recursive: true});
    }

    // Write the stats to the file
    writeFile(filePath, statsString);
}

function writeFile(filePath: string, data: string, encoding: BufferEncoding = 'utf8'): void {
    let fd = 0;
    try {
        fd = fs.openSync(filePath, 'w');
        fs.writeSync(fd, data, 0, encoding);
    } catch (error) {
        log.error('Error writing file: ' + error);
    } finally {
        if (fd !== 0) {
            fs.closeSync(fd);
        }
    }
}

function createDestinationDisplayForTrip(
    destinationDisplays: Element,
    cs: string,
    trip: Trip,
    translationsMap: Record<string, Record<string, string>>,
    ddId?: string
): Element {
    // Normalize the headsign ID
    const normalizedId = normalizeGtfsId(trip.trip_headsign);
    const id = ddId ?? `${cs}DestinationDisplay:${normalizeGtfsId(trip.trip_headsign || 'unknown')}`;

    const doc = destinationDisplays.ownerDocument!;

    // Create the DestinationDisplay element
    const destinationDisplay = doc.createElement('DestinationDisplay');
    destinationDisplay.setAttribute('version', '1');
    destinationDisplay.setAttribute('id', id);

    // Include translated headsigns if available
    const translations = translationsMap[trip.trip_id];
    if (translations) {
        const alternativeTexts = doc.createElement('alternativeTexts');
        for (const language in translations) {
            const translatedName = translations[language];
            const alternativeText = doc.createElement('AlternativeText');
            alternativeText.setAttribute('attributeName', 'FrontText');
            alternativeText.setAttribute(
                'id',
                `${cs}AlternativeText:Trip_${normalizedId}_${language}`
            );
            alternativeText.setAttribute('version', '1');

            const text = doc.createElement('Text');
            text.setAttribute('lang', language);
            text.appendChild(doc.createTextNode(translatedName));

            alternativeText.appendChild(text);
            alternativeTexts.appendChild(alternativeText);
        }
        destinationDisplay.appendChild(alternativeTexts);
    }

    // Add the FrontText node
    const frontText = doc.createElement('FrontText');
    frontText.appendChild(doc.createTextNode(trip.trip_headsign));
    destinationDisplay.appendChild(frontText);

    // Append the DestinationDisplay to the parent element
    destinationDisplays.appendChild(destinationDisplay);

    return destinationDisplay;
}

function createDestinationDisplayForStopTime(
    destinationDisplays: Element,
    cs: string,
    stopTime: StopTime,
    translationsMap: Record<string, Record<string, string>>,
    ddId?: string
): Element {
    // Build or use the supplied DestinationDisplay ID
    const headsign: string = stopTime.stop_headsign || 'unknown';
    const normalizedId: string = normalizeGtfsId(headsign);
    const destinationDisplayId: string = ddId ?? `${cs}DestinationDisplay:${normalizedId}`;

    const doc: Document = destinationDisplays.ownerDocument!;

    // Create the DestinationDisplay element
    const destinationDisplay: Element = doc.createElement('DestinationDisplay');
    destinationDisplay.setAttribute('version', '1');
    destinationDisplay.setAttribute('id', destinationDisplayId);

    // Include translated headsigns if available
    const translations = translationsMap[stopTime.trip_id];
    if (translations) {
        const alternativeTexts = doc.createElement('alternativeTexts');
        for (const language in translations) {
            const translatedName = translations[language];
            const alternativeText = doc.createElement('AlternativeText');
            alternativeText.setAttribute('attributeName', 'FrontText');
            alternativeText.setAttribute(
                'id',
                `${cs}AlternativeText:StopTime_${normalizedId}_${language}`
            );
            alternativeText.setAttribute('version', '1');

            const text = doc.createElement('Text');
            text.setAttribute('lang', language);
            text.appendChild(doc.createTextNode(translatedName));

            alternativeText.appendChild(text);
            alternativeTexts.appendChild(alternativeText);
        }
        destinationDisplay.appendChild(alternativeTexts);
    }

    // Add the FrontText node
    const frontText = doc.createElement('FrontText');
    frontText.appendChild(doc.createTextNode(stopTime.stop_headsign));
    destinationDisplay.appendChild(frontText);

    // Append the DestinationDisplay to the parent element
    destinationDisplays.appendChild(destinationDisplay);

    return destinationDisplay;
}

const transportModePriority = ['air', 'water', 'rail', 'metro', 'bus', 'tram', 'cablecar', 'gondola', 'funicular', 'other']; // Higher priority first

function getTransportModePriority(mode: string): number {
    const priority = transportModePriority.indexOf(mode);
    return priority === -1 ? transportModePriority.length : priority; // Return a lower priority if not found
}

function setTransportModeWithPriority(
    stopPlace: Element,
    gtfsRouteType: number,
    cs: string
): void {
    const doc = stopPlace.ownerDocument!;

    // Convert GTFS route type to NeTEx transport mode
    const netexTransportMode = getTransportMode(gtfsRouteType);

    // Find or create the TransportMode element
    let transportModeElement = getElementFromElement('TransportMode', stopPlace);
    if (!transportModeElement) {
        transportModeElement = doc.createElement('TransportMode');
        transportModeElement.appendChild(doc.createTextNode(netexTransportMode));
        stopPlace.appendChild(transportModeElement);

        // Add StopPlaceType since this is the primary mode
        const stopPlaceTypeElement = doc.createElement('StopPlaceType');
        stopPlaceTypeElement.appendChild(doc.createTextNode(getStopPlaceType(gtfsRouteType)));
        stopPlace.appendChild(stopPlaceTypeElement);

        return; // Exit since the primary mode has been set
    }

    // Get the existing primary mode and its priority
    const existingTransportMode = transportModeElement.textContent || '';
    const existingPriority = getTransportModePriority(existingTransportMode);
    const currentPriority = getTransportModePriority(netexTransportMode);

    if (currentPriority < existingPriority) {
        // Update primary TransportMode
        transportModeElement.textContent = netexTransportMode;

        // Update StopPlaceType based on the new primary mode
        let stopPlaceTypeElement = getElementFromElement('StopPlaceType', stopPlace);
        if (!stopPlaceTypeElement) {
            stopPlaceTypeElement = doc.createElement('StopPlaceType');
            stopPlace.appendChild(stopPlaceTypeElement);
        }
        stopPlaceTypeElement.textContent = getStopPlaceType(gtfsRouteType);

        // Move the old primary mode to OtherTransportModes
        updateOtherTransportModes(stopPlace, existingTransportMode);
    } else if (netexTransportMode !== existingTransportMode) {
        // Add the current mode to OtherTransportModes if it's not the primary
        updateOtherTransportModes(stopPlace, netexTransportMode);
    }
}

function updateOtherTransportModes(stopPlace: Element, modeToAdd: string): void {
    const doc = stopPlace.ownerDocument!;

    // Find the existing OtherTransportModes element
    let existingOtherTransportModesElement = getElementFromElement('OtherTransportModes', stopPlace);

    // Collect modes from the existing OtherTransportModes element
    const otherModes = new Set<string>();
    if (existingOtherTransportModesElement) {
        const existingModes = existingOtherTransportModesElement.textContent || '';
        existingModes.split(' ').filter(Boolean).forEach(mode => otherModes.add(mode));

        // Remove the existing OtherTransportModes element
        stopPlace.removeChild(existingOtherTransportModesElement);
    }

    // Add the new mode to the set
    otherModes.add(modeToAdd);

    // Re-create OtherTransportModes element with updated content
    const newOtherTransportModesElement = doc.createElement('OtherTransportModes');
    newOtherTransportModesElement.textContent = Array.from(otherModes).join(' ');

    // Find the TransportMode element
    const transportModeElement = getElementFromElement('TransportMode', stopPlace);

    // Insert OtherTransportModes right after TransportMode
    if (transportModeElement?.nextSibling) {
        stopPlace.insertBefore(newOtherTransportModesElement, transportModeElement.nextSibling);
    } else {
        stopPlace.appendChild(newOtherTransportModesElement);
    }
}

// Safely get a single Element from a Document
function getElementFromDocument(expression: string, doc: Document): Element | null {
    // @ts-ignore
    const result = xpath.select1(expression, doc as unknown as Node); // Cast to Node
    return result instanceof Element ? result : null;
}

// Safely get a single Element from an Element
function getElementFromElement(expression: string, element: Element): Element | null {
    // @ts-ignore
    const result = xpath.select1(expression, element as unknown as Node); // Cast to Node
    return result instanceof Element ? result : null;
}

function addCompositeFrameValidity(
    xmlDoc: Document,
    compositeFrame: Element,
    gtfs: Gtfs,
    cs: string
): void {
    let fromDate: string | null = null;
    let toDate: string | null = null;

    // Prefer GTFS feed_info dates if present
    const feedInfo = gtfs.feed_info?.[0];
    if (feedInfo?.feed_start_date) {
        fromDate = DateTime.fromFormat(feedInfo.feed_start_date, 'yyyyMMdd', { zone: 'UTC' })
            .startOf('day')
            .toISO({ suppressMilliseconds: true });
    }
    if (feedInfo?.feed_end_date) {
        toDate = DateTime.fromFormat(feedInfo.feed_end_date, 'yyyyMMdd', { zone: 'UTC' })
            .endOf('day')
            .toISO({ suppressMilliseconds: true });
    }

    // Fall back to calendar ranges if needed
    if (!fromDate || !toDate) {
        const candidates: DateTime[] = [];
        for (const c of gtfs.calendar || []) {
            if (c.start_date)
                candidates.push(DateTime.fromFormat(c.start_date, 'yyyyMMdd', { zone: 'UTC' }).startOf('day'));
            if (c.end_date)
                candidates.push(DateTime.fromFormat(c.end_date, 'yyyyMMdd', { zone: 'UTC' }).endOf('day'));
        }
        for (const cd of gtfs.calendar_dates || []) {
            if (cd.date) candidates.push(DateTime.fromFormat(cd.date, 'yyyyMMdd', { zone: 'UTC' }));
        }

        if (candidates.length > 0) {
            const min = candidates.reduce((a, b) => (a < b ? a : b));
            const max = candidates.reduce((a, b) => (a > b ? a : b));
            fromDate = fromDate || min.toISO({ suppressMilliseconds: true });
            toDate = toDate || max.toISO({ suppressMilliseconds: true });
        }
    }

    // Final fallback window (6 months from now)
    if (!fromDate || !toDate) {
        const now = DateTime.now().setZone('UTC');
        fromDate = now.startOf('day').toISO({ suppressMilliseconds: true });
        toDate = now.plus({ months: 6 }).endOf('day').toISO({ suppressMilliseconds: true });
    }

    const createValidityConditions = (): Element => {
        const validity = xmlDoc.createElement('validityConditions');
        const availability = xmlDoc.createElement('AvailabilityCondition');
        availability.setAttribute('id', `${cs}AvailabilityCondition:CompositeFrame_1`);
        availability.setAttribute('version', '1');

        const fromDateEl = xmlDoc.createElement('FromDate');
        fromDateEl.textContent = fromDate!;
        availability.appendChild(fromDateEl);

        if (toDate) {
            const toDateEl = xmlDoc.createElement('ToDate');
            toDateEl.textContent = toDate!;
            availability.appendChild(toDateEl);
        }

        validity.appendChild(availability);
        return validity;
    };

    // Insert CompositeFrame-level <validityConditions> BEFORE <FrameDefaults>
    const frameDefaults = compositeFrame.getElementsByTagName('FrameDefaults')[0] || null;
    const compositeLevelValidity = createValidityConditions();
    compositeFrame.insertBefore(compositeLevelValidity, frameDefaults);
}

function ensureAuthorityInResourceFrame(
    xmlDoc: Document,
    resourceFrame: Element,
    agency: Agency,
    cs: string
): string {
    const authorityId = `${cs}Authority:${normalizeGtfsId(agency.agency_id || agency.agency_name || 'default')}`;

    // Find or create <organisations>
    let organisations = resourceFrame.getElementsByTagName('organisations')[0] as Element | undefined;
    if (!organisations) {
        organisations = xmlDoc.createElement('organisations');
        resourceFrame.appendChild(organisations);
    }

    // Find Authority by id (matching version if present)
    let authority: Element | undefined;
    const existingAuthorities = organisations.getElementsByTagName('Authority');
    for (let i = 0; i < existingAuthorities.length; i++) {
        const el = existingAuthorities[i] as Element;
        if (el.getAttribute('id') === authorityId) {
            authority = el;
            break;
        }
    }

    // Create <Authority> if not found
    if (!authority) {
        authority = xmlDoc.createElement('Authority');
        authority.setAttribute('id', authorityId);
        authority.setAttribute('version', '1');

        // Add <Name>
        const nameEl = xmlDoc.createElement('Name');
        nameEl.textContent = agency.agency_name || 'Unknown Authority';
        authority.appendChild(nameEl);

        organisations.appendChild(authority);
    } else {
        // Ensure <Name> exists
        if (authority.getElementsByTagName('Name').length === 0) {
            const nameEl = xmlDoc.createElement('Name');
            nameEl.textContent = agency.agency_name || 'Unknown Authority';
            authority.appendChild(nameEl);
        }
    }

    // Ensure <ContactDetails> exists and is populated
    ensureContactDetailsOnAuthority(xmlDoc, authority, agency);

    return authorityId;
}

function ensureContactDetailsOnAuthority(xmlDoc: Document, authority: Element, agency: Agency) {
    let contactDetails = authority.getElementsByTagName('ContactDetails')[0] as Element | undefined;
    if (!contactDetails) {
        contactDetails = xmlDoc.createElement('ContactDetails');
        authority.appendChild(contactDetails);
    }

    // Ensure URL (mandatory)
    let urlEl = contactDetails.getElementsByTagName('Url')[0] as Element | undefined;
    if (!urlEl) {
        urlEl = xmlDoc.createElement('Url');
        contactDetails.appendChild(urlEl);
    }
    if (agency.agency_url && agency.agency_url.startsWith('http')) {
        urlEl.textContent = agency.agency_url;
    } else if (agency.agency_url) {
        urlEl.textContent = `https://${agency.agency_url}`;
        log.warn(
            `GTFS agency_url "${agency.agency_url}" did not start with http/https. Added https:// prefix.`
        );
    } else {
        urlEl.textContent = "https://example.com/unknown";
        log.warn(
            `GTFS agency_url missing for agency "${agency.agency_name}". Added placeholder URL.`
        );
    }

    // Optionally add further details if present
    if (agency.agency_phone) {
        let further = contactDetails.getElementsByTagName('FurtherDetails')[0] as Element | undefined;
        if (!further) {
            further = xmlDoc.createElement('FurtherDetails');
            contactDetails.appendChild(further);
        }
        further.textContent = `Phone: ${agency.agency_phone}`;
    }
}

// Ensure fallback DayType is created in ServiceCalendarFrame
function ensureFallbackDayType(xmlDoc: Document, cs: string): Element {
    // Locate the ServiceCalendarFrame
    const serviceCalendarFrame = getElementFromDocument('//ServiceCalendarFrame', xmlDoc);
    if (!serviceCalendarFrame) {
        throw new Error('ServiceCalendarFrame not found — required for defining DayTypes.');
    }

    // Ensure <dayTypes> exists
    let dayTypes = serviceCalendarFrame.getElementsByTagName('dayTypes')[0] as Element | undefined;
    if (!dayTypes) {
        dayTypes = xmlDoc.createElement('dayTypes');
        // Insert at top for canonical order
        serviceCalendarFrame.insertBefore(dayTypes, serviceCalendarFrame.firstChild);
    }

    // Create fallback DayType if not present
    const fallbackId = `${cs}DayType:Default`;
    let fallback = Array.from(dayTypes.getElementsByTagName('DayType')).find(dt => dt.getAttribute('id') === fallbackId) as Element | undefined;

    if (!fallback) {
        fallback = xmlDoc.createElement('DayType');
        fallback.setAttribute('id', fallbackId);
        fallback.setAttribute('version', '1');

        const nameEl = xmlDoc.createElement('Name');
        nameEl.textContent = 'Fallback DayType (invalid GTFS service_id)';
        fallback.appendChild(nameEl);

        dayTypes.appendChild(fallback);
    }

    return fallback;
}

function buildStopPointInJourneyPatternId(cs: string, journeyPatternId: string, stopId: string, index: number): string {
    // Extract the identifier part after "JourneyPattern:"
    const jpKey =
        journeyPatternId.includes('JourneyPattern:')
            ? journeyPatternId.split('JourneyPattern:')[1]
            : journeyPatternId.split(':').pop() || journeyPatternId;

    // Normalize parts to be NeTEx-safe
    const identifier = `${normalizeGtfsId(jpKey)}_${normalizeGtfsId(stopId)}_${index}`;

    // Compose ID in strict NeTEx form with a single colon after element type
    return `${cs}StopPointInJourneyPattern:${identifier}`;
}

function formatTime(raw: string): { time: string; dayOffset?: number } {
    const [h, m, s] = raw.split(':').map(Number);
    const dayOffset = h > 23 ? Math.floor(h / 24) : undefined;
    const hh = (h % 24).toString().padStart(2, '0');
    const mm = (m ?? 0).toString().padStart(2, '0');
    const ss = (s ?? 0).toString().padStart(2, '0');
    return { time: `${hh}:${mm}:${ss}`, dayOffset };
}

function normalizeServiceId(id?: string): string {
    return (id || '').trim();
}
function normalizeGtfsId(id: string): string {
    return id.replace(/[^A-Za-z0-9:_-]/g, '_'); // Replace anything unsafe with underscore
}

export {
    Stats,
    findAgencyForId,
    findTripsForRouteId,
    findStopsForTrips,
    findStopTimesForTripId,
    indexStopTimesByTripId,
    indexStopsById,
    getNetexLineId,
    getNetexOperatorId,
    getTransportMode,
    getStopPlaceType,
    findCalendarsForTrips,
    findCalendarDatesForTrips,
    getCodeSpaceForAgency,
    writeXmlDocToFile,
    writeStatsToFile,
    addAccessibilityAssessment,
    getTranslationsMap,
    createDestinationDisplayForTrip,
    createDestinationDisplayForStopTime,
    setTransportModeWithPriority,
    buildStopPointInJourneyPatternId,
    formatTime,
    normalizeGtfsId,
    normalizeServiceId,
    getElementFromDocument,
    getElementFromElement,
    addCompositeFrameValidity,
    ensureAuthorityInResourceFrame,
    ensureFallbackDayType,
};
