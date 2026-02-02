import {Agency, Gtfs, Route, Stop, StopTime, Trip, FeedInfo, Shape} from "../utils/gtfs-types";
import { Document, Element } from '@xmldom/xmldom';
import { DOMImplementation } from '@xmldom/xmldom';
import _ from 'lodash';
import {
    Stats,
    findAgencyForId,
    getNetexOperatorId,
    getNetexLineId,
    getTransportMode,
    findTripsForRouteId,
    findStopsForTrips,
    findStopTimesForTripId,
    getCodeSpaceForAgency,
    writeXmlDocToFile,
    writeStatsToFile,
    indexStopTimesByTripId,
    indexStopsById,
    replaceAttributeContainingString,
    getTranslationsMap,
    addAccessibilityAssessment,
    createDestinationDisplayForTrip,
    createDestinationDisplayForStopTime,
    setTransportModeWithPriority,
    normalizeGtfsId,
    getElementFromElement,
    getElementFromDocument,
    getCountFromXPath,
    addCompositeFrameValidity,
    ensureAuthorityInResourceFrame,
    ensureFallbackDayType,
    buildStopPointInJourneyPatternId, normalizeServiceId, formatTime

} from "./utils";
import { createDayTypesForRoute } from "./daytypes";
import { rootLogger } from "../utils/logger";
import { writeAllStopsStreaming } from "./writestops";

const log = rootLogger.child({src: 'netex.ts'});

async function writeNeTEx(gtfs: Gtfs, filePath: string, stopsOnly: boolean = false): Promise<string> {
    const stoptimesIndex = indexStopTimesByTripId(gtfs);
    const stopIndex = indexStopsById(gtfs);
    const stopPlacesMap: { [stopPlaceId: string]: Element } = {};

    const stats: Stats = {} as Stats;
    stats.JourneyPatterns = 0;
    stats.ServiceJourneys = 0;
    stats.Lines = gtfs.routes.length;

    const gcFrequency = 5; // Trigger GC every 5 objects (if enabled)
    let lastGcCall = 0;
    const formatXML = gtfs.routes.length <= 99; // Format XML only for small datasets

    for (let i = 0; i < gtfs.routes.length; i++) {
        const route = gtfs.routes[i];
        const agency = findAgencyForId(gtfs, route.agency_id);
        const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
        const lineId = getNetexLineId(route, agency, feedInfo as FeedInfo);

        log.info(`Generating NeTEx for route ${i + 1} of ${gtfs.routes.length}: ${lineId} (${route.route_short_name} / ${agency.agency_name})`);

        const xmlDoc = createNetexDocumentTemplate(false);
        const serviceFrame = getElementFromDocument('//ServiceFrame', xmlDoc) as Element;
        const resourceFrame = getElementFromDocument('//ResourceFrame', xmlDoc) as Element;
        const serviceCalendarFrame = getElementFromDocument('//ServiceCalendarFrame', xmlDoc) as Element;
        const organisations = getElementFromElement('organisations', resourceFrame) as Element;
        const compositeFrame = getElementFromDocument('//CompositeFrame', xmlDoc) as Element;
        const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);
        addCompositeFrameValidity(xmlDoc, compositeFrame, gtfs, cs);

        const networkId = fillNetwork(xmlDoc, serviceFrame, resourceFrame, agency, feedInfo as FeedInfo);
        createNetexStops(gtfs, xmlDoc, route, stopIndex, stoptimesIndex, stopPlacesMap);

        if (!stopsOnly) {
            const operator = createNetexOperatorFromGtfsRoute(gtfs, organisations, route);
            const line = createNetexLineFromGtfsRoute(gtfs, serviceFrame, route, networkId);
            createNetexRouteFromGtfsRoute(gtfs, serviceFrame, route, stopIndex, stoptimesIndex);
            const dayTypes = createDayTypesForRoute(gtfs, serviceCalendarFrame, route, agency);
            createNetexJourneys(gtfs, xmlDoc, route, dayTypes, operator, line, agency, feedInfo as FeedInfo, stoptimesIndex, stats);
            createNetexServiceLinks(gtfs, xmlDoc, route, stoptimesIndex);

            replaceAttributeContainingString(xmlDoc, 'id', 'perille_', 'Fintraffic_');
            replaceAttributeContainingString(xmlDoc, 'ref', 'perille_', 'Fintraffic_');

            const fileName = _.snakeCase(lineId.replace('perille_', 'Fintraffic_')) + '.xml';
            writeXmlDocToFile(xmlDoc, filePath, fileName, formatXML);
        }

        // Clear the XML document from memory
        xmlDoc.removeChild(xmlDoc.documentElement!);

        // Force GC periodically (configurable frequency)
        if (typeof global.gc === 'function' && i - lastGcCall >= gcFrequency) {
            global.gc();
            lastGcCall = i;
            const used = process.memoryUsage();
            log.info(
                `[GC] after route ${i + 1}/${gtfs.routes.length} — heapUsed: ${(used.heapUsed / 1024 / 1024).toFixed(1)} MB, rss: ${(used.rss / 1024 / 1024).toFixed(1)} MB`
            );
        }

        log.info(`...done. (stop count: ${Object.keys(stopPlacesMap).length})`);
    }

    log.info("Writing all stops...");
    let publisherName = gtfs.feed_info?.[0]?.feed_publisher_name;
    publisherName = publisherName
        ? _.camelCase(publisherName).slice(0, 3).toLowerCase()
        : "oth";

    // Now the streaming function returns the counts
    const { stopPlaceCount, quayCount } =
        writeAllStopsStreaming(stopPlacesMap, filePath, publisherName);

    stats.StopPlaces = stopPlaceCount;
    stats.Quays = quayCount;

    const statsFileName = `${publisherName}_stats.json`;
    writeStatsToFile(stats, filePath, statsFileName);

    log.info(`Wrote ${stopPlaceCount} stop places.`);
    return "";
}

function createNetexDocumentTemplate(stopsOnly: boolean): Document {
    const dom = new DOMImplementation();
    const xmlDoc = dom.createDocument(null, 'PublicationDelivery', null);

    // Set namespaces for the root element
    const publicationDelivery = xmlDoc.documentElement!;
    publicationDelivery.setAttribute('xmlns', 'http://www.netex.org.uk/netex');
    publicationDelivery.setAttribute('xmlns:gml', 'http://www.opengis.net/gml/3.2');

    // Add PublicationTimestamp
    const publicationTimestamp = xmlDoc.createElement('PublicationTimestamp');
    publicationTimestamp.textContent = new Date().toISOString();
    publicationDelivery.appendChild(publicationTimestamp);

    // Add ParticipantRef
    const participantRef = xmlDoc.createElement('ParticipantRef');
    participantRef.textContent = 'FSR';
    publicationDelivery.appendChild(participantRef);

    // Add dataObjects
    const dataObjects = xmlDoc.createElement('dataObjects');
    publicationDelivery.appendChild(dataObjects);

    if (stopsOnly) {
        const siteFrame = xmlDoc.createElement('SiteFrame');
        siteFrame.setAttribute('id', 'SiteFrame_1');
        siteFrame.setAttribute('version', '1');
        dataObjects.appendChild(siteFrame);

        const frameDefaults = xmlDoc.createElement('FrameDefaults');
        siteFrame.appendChild(frameDefaults);

        const defaultLocale = xmlDoc.createElement('DefaultLocale');
        frameDefaults.appendChild(defaultLocale);

        const timeZone = xmlDoc.createElement('TimeZone');
        timeZone.textContent = 'Europe/Helsinki'; // TODO: Parameterize
        defaultLocale.appendChild(timeZone);

        const defaultLanguage = xmlDoc.createElement('DefaultLanguage');
        defaultLanguage.textContent = 'fi';
        defaultLocale.appendChild(defaultLanguage);

        const defaultLocationSystem = xmlDoc.createElement('DefaultLocationSystem');
        defaultLocationSystem.textContent = 'WGS84';
        frameDefaults.appendChild(defaultLocationSystem);

        return xmlDoc;
    }

    // Create CompositeFrame and its children
    const compositeFrame = xmlDoc.createElement('CompositeFrame');
    compositeFrame.setAttribute('id', 'CompositeFrame_1');
    compositeFrame.setAttribute('version', '1');
    dataObjects.appendChild(compositeFrame);

    const frameDefaults = xmlDoc.createElement('FrameDefaults');
    compositeFrame.appendChild(frameDefaults);

    const defaultLocale = xmlDoc.createElement('DefaultLocale');
    frameDefaults.appendChild(defaultLocale);

    const timeZone = xmlDoc.createElement('TimeZone');
    timeZone.textContent = 'Europe/Helsinki'; // TODO: Parameterize
    defaultLocale.appendChild(timeZone);

    const defaultLanguage = xmlDoc.createElement('DefaultLanguage');
    defaultLanguage.textContent = 'fi';
    defaultLocale.appendChild(defaultLanguage);

    const defaultLocationSystem = xmlDoc.createElement('DefaultLocationSystem');
    defaultLocationSystem.textContent = 'WGS84';
    frameDefaults.appendChild(defaultLocationSystem);

    const frames = xmlDoc.createElement('frames');
    compositeFrame.appendChild(frames);

    // Add frames
    const resourceFrame = xmlDoc.createElement('ResourceFrame');
    resourceFrame.setAttribute('id', 'ResourceFrame_1');
    resourceFrame.setAttribute('version', '1');
    frames.appendChild(resourceFrame);

    const organisations = xmlDoc.createElement('organisations');
    resourceFrame.appendChild(organisations);

    const siteFrame = xmlDoc.createElement('SiteFrame');
    siteFrame.setAttribute('id', 'SiteFrame_1');
    siteFrame.setAttribute('version', '1');
    frames.appendChild(siteFrame);

    const serviceFrame = xmlDoc.createElement('ServiceFrame');
    serviceFrame.setAttribute('id', 'ServiceFrame_1');
    serviceFrame.setAttribute('version', '1');
    frames.appendChild(serviceFrame);

    serviceFrame.appendChild(xmlDoc.createElement('Network'));
    serviceFrame.appendChild(xmlDoc.createElement('routePoints'));
    serviceFrame.appendChild(xmlDoc.createElement('routes'));
    serviceFrame.appendChild(xmlDoc.createElement('lines'));
    serviceFrame.appendChild(xmlDoc.createElement('destinationDisplays'));
    serviceFrame.appendChild(xmlDoc.createElement('scheduledStopPoints'));
    serviceFrame.appendChild(xmlDoc.createElement('serviceLinks'));
    serviceFrame.appendChild(xmlDoc.createElement('stopAssignments'));
    serviceFrame.appendChild(xmlDoc.createElement('journeyPatterns'));

    const serviceCalendarFrame = xmlDoc.createElement('ServiceCalendarFrame');
    serviceCalendarFrame.setAttribute('id', 'ServiceCalendarFrame_1');
    serviceCalendarFrame.setAttribute('version', '1');
    frames.appendChild(serviceCalendarFrame);

    const timetableFrame = xmlDoc.createElement('TimetableFrame');
    timetableFrame.setAttribute('id', 'TimetableFrame_1');
    timetableFrame.setAttribute('version', '1');
    frames.appendChild(timetableFrame);

    return xmlDoc;
}

function fillNetwork(
    xmlDoc: Document,
    serviceFrame: Element,
    resourceFrame: Element,
    agency: Agency,
    feedInfo: FeedInfo
): string {
    const cs = getCodeSpaceForAgency(agency, feedInfo); // e.g., "FIN:"
    const networkId = `${cs}Network:${normalizeGtfsId(agency.agency_id || agency.agency_name || 'default')}`;

    // Ensure <Authority> exists in resource frame
    const authorityId = ensureAuthorityInResourceFrame(xmlDoc, resourceFrame, agency, cs);

    // Ensure <Network> exists in <ServiceFrame>
    let network = serviceFrame.getElementsByTagName('Network')[0] as Element | undefined;
    if (!network) {
        network = xmlDoc.createElement('Network');
        serviceFrame.insertBefore(network, serviceFrame.firstChild); // place early in ServiceFrame
    }

    // Ensure Network has ID + version
    if (!network.getAttribute('id')) {
        network.setAttribute('id', networkId);
    }
    if (!network.getAttribute('version')) {
        network.setAttribute('version', '1');
    }

    // Ensure <Name>
    let nameEl = network.getElementsByTagName('Name')[0];
    if (!nameEl) {
        nameEl = xmlDoc.createElement('Name');
        network.insertBefore(nameEl, network.firstChild);
    }
    nameEl.textContent = agency.agency_name || 'Default Network';

    // Ensure <AuthorityRef>
    let authorityRef = network.getElementsByTagName('AuthorityRef')[0];
    if (!authorityRef) {
        authorityRef = xmlDoc.createElement('AuthorityRef');
        network.appendChild(authorityRef);
    }
    if (!authorityRef.getAttribute('ref')) {
        authorityRef.setAttribute('ref', authorityId);
    }
    if (!authorityRef.getAttribute('version')) {
        authorityRef.setAttribute('version', '1');
    }

    return networkId; // Use this in <Line><RepresentedByGroupRef ref="..."/>
}

function createNetexOperatorFromGtfsRoute(gtfs: Gtfs, parent: Element, gtfsRoute: Route): Element {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);

    // Create the Operator element
    const operatorElement = parent.appendChild(parent.ownerDocument!.createElement('Operator')) as Element;
    operatorElement.setAttribute('id', getNetexOperatorId(agency));
    operatorElement.setAttribute('version', '1');

    // Create and set the Name element
    const nameElement = operatorElement.appendChild(parent.ownerDocument!.createElement('Name')) as Element;
    nameElement.textContent = agency.agency_name;

    return operatorElement;
}

function createNetexLineFromGtfsRoute(
    gtfs: Gtfs,
    parent: Element,
    gtfsRoute: Route,
    networkId: string
): Element {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);

    // Ensure the 'lines' container exists
    const lines = getElementFromElement('lines', parent) || parent.appendChild(parent.ownerDocument!.createElement('lines')) as Element;

    const lineNameTranslationsMap: Record<string, Record<string, string>> = getTranslationsMap(
        gtfs.translations || [],
        'routes',
        'route_long_name'
    );

    // Create the Line element
    const lineElement = lines.appendChild(parent.ownerDocument!.createElement('Line')) as Element;
    lineElement.setAttribute('id', getNetexLineId(gtfsRoute, agency, feedInfo as FeedInfo));
    lineElement.setAttribute('version', '1');

    // Set the Name and alternativeTexts if translations are available
    if (gtfsRoute.route_long_name && gtfsRoute.route_long_name.trim()) {
        // Check for translations
        if (lineNameTranslationsMap[gtfsRoute.route_id]) {
            const alternativeTexts = lineElement.appendChild(parent.ownerDocument!.createElement('alternativeTexts')) as Element;
            for (const language in lineNameTranslationsMap[gtfsRoute.route_id]) {
                const translatedName = lineNameTranslationsMap[gtfsRoute.route_id][language];
                const alternativeText = alternativeTexts.appendChild(parent.ownerDocument!.createElement('AlternativeText')) as Element;

                const altTextId = `${cs}AlternativeText:${gtfsRoute.route_id}:${language}`;
                alternativeText.setAttribute('id', altTextId);
                alternativeText.setAttribute('version', '1');
                alternativeText.setAttribute('attributeName', 'Name');

                const text = alternativeText.appendChild(parent.ownerDocument!.createElement('Text')) as Element;
                text.setAttribute('lang', language);
                text.textContent = translatedName;
            }
        }
        const name = lineElement.appendChild(parent.ownerDocument!.createElement('Name')) as Element;
        name.textContent = gtfsRoute.route_long_name;
    }

    // Set TransportMode
    const transportMode = lineElement.appendChild(parent.ownerDocument!.createElement('TransportMode')) as Element;
    transportMode.textContent = getTransportMode(gtfsRoute.route_type);

    // Set PublicCode if available
    if (gtfsRoute.route_short_name && gtfsRoute.route_short_name.trim()) {
        const publicCode = lineElement.appendChild(parent.ownerDocument!.createElement('PublicCode')) as Element;
        publicCode.textContent = gtfsRoute.route_short_name;
    }

    // Set OperatorRef
    const operatorRef = lineElement.appendChild(parent.ownerDocument!.createElement('OperatorRef')) as Element;
    operatorRef.setAttribute('ref', getNetexOperatorId(findAgencyForId(gtfs, gtfsRoute.agency_id)));
    operatorRef.setAttribute('version', '1');

    // Set RepresentedByGroupRef to link to Network
    const reprRef = parent.ownerDocument!.createElement('RepresentedByGroupRef');
    reprRef.setAttribute('ref', networkId); // networkId must match the <Network id="...">
    reprRef.setAttribute('version', '1');
    lineElement.appendChild(reprRef);

    return lineElement; // Return the Line element
}

function createNetexRouteFromGtfsRoute(
    gtfs: Gtfs,
    parent: Element,
    gtfsRoute: Route,
    stopIndex: { [p: string]: Stop },
    stoptimesIndex: { [trip_id: string]: StopTime[] }
): Element {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);

    // Ensure routes container exists
    const routes = getElementFromElement('routes', parent) || parent.appendChild(parent.ownerDocument!.createElement('routes')) as Element;

    const routeId = `${cs}Route:${normalizeGtfsId(gtfsRoute.route_id)}`;
    const routeElement = routes.appendChild(parent.ownerDocument!.createElement('Route')) as Element;
    routeElement.setAttribute('id', routeId);
    routeElement.setAttribute('version', '1');

    // Set Name element
    if (gtfsRoute.route_long_name && gtfsRoute.route_long_name.trim()) {
        (routeElement.appendChild(parent.ownerDocument!.createElement('Name')) as Element).textContent = gtfsRoute.route_long_name;
    } else if (gtfsRoute.route_short_name && gtfsRoute.route_short_name.trim()) {
        (routeElement.appendChild(parent.ownerDocument!.createElement('Name')) as Element).textContent = gtfsRoute.route_short_name;
    }

    // Set LineRef
    const lineId = getNetexLineId(gtfsRoute, agency, feedInfo as FeedInfo);
    const lineRef = routeElement.appendChild(parent.ownerDocument!.createElement('LineRef')) as Element;
    lineRef.setAttribute('ref', lineId);
    lineRef.setAttribute('version', '1');

    // Add points in sequence
    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    if (trips.length > 0) {
        const pointsInSequence = routeElement.appendChild(parent.ownerDocument!.createElement('pointsInSequence')) as Element;
        const stopTimes = findStopTimesForTripId(stoptimesIndex, trips[0].trip_id);

        for (let i = 0; i < stopTimes.length; i++) {
            const stopTime = stopTimes[i];
            const stop = stopIndex[stopTime.stop_id];

            if (!stop) {
                log.warn(`Stop not found for stop_id: ${stopTime.stop_id}`);
                continue;
            }

            const pointOnRouteId = `${cs}PointOnRoute:${stop.stop_id}-${i}`;
            const pointOnRoute = pointsInSequence.appendChild(parent.ownerDocument!.createElement('PointOnRoute')) as Element;
            pointOnRoute.setAttribute('id', pointOnRouteId);
            pointOnRoute.setAttribute('version', '1');
            pointOnRoute.setAttribute('order', (i + 1).toString());

            const routePointId = `${cs}RoutePoint:${stop.stop_id}`;
            const routePointRef = pointOnRoute.appendChild(parent.ownerDocument!.createElement('RoutePointRef')) as Element;
            routePointRef.setAttribute('ref', routePointId);
            routePointRef.setAttribute('version', '1');
        }
    }

    return routeElement;
}

const USE_AGENCY_CODESPACES = true; // process.env.USE_AGENCY_CODESPACES === 'true'

function createNetexStops(
    gtfs: Gtfs,
    xmlDoc: Document,
    gtfsRoute: Route,
    stopIndex: { [p: string]: Stop },
    stoptimesIndex: { [trip_id: string]: StopTime[] },
    stopPlacesMap: { [stopPlaceId: string]: Element },
    allStopsOnly = false
): void {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);
    const stopCs = USE_AGENCY_CODESPACES ? cs : 'FSR:';

    const siteFrame = getElementFromDocument('//SiteFrame', xmlDoc);
    if (!siteFrame) {
        throw new Error('SiteFrame not found.');
    }

    const stopPlaces = getElementFromElement('stopPlaces', siteFrame) || siteFrame.appendChild(xmlDoc.createElement('stopPlaces'));

    let serviceFrame: Element | null = null;
    let scheduledStopPoints: Element | null = null;
    let stopAssignments: Element | null = null;
    let routePoints: Element | null = null;
    let trips: Trip[] = [];
    let stops: Stop[] = [];

    if (allStopsOnly) {
        stops = gtfs.stops;
    } else {
        serviceFrame = getElementFromDocument('//ServiceFrame', xmlDoc);
        if (!serviceFrame) {
            throw new Error('ServiceFrame not found.');
        }

        scheduledStopPoints = getElementFromElement('scheduledStopPoints', serviceFrame) || (serviceFrame.appendChild(xmlDoc.createElement('scheduledStopPoints')) as Element);
        stopAssignments = getElementFromElement('stopAssignments', serviceFrame) || (serviceFrame.appendChild(xmlDoc.createElement('stopAssignments')) as Element);
        routePoints = getElementFromElement('routePoints', serviceFrame) || (serviceFrame.appendChild(xmlDoc.createElement('routePoints')) as Element);

        // scheduledStopPoints = getElementFromElement('scheduledStopPoints', serviceFrame) || serviceFrame.appendChild(xmlDoc.createElement('scheduledStopPoints') as Element);
        // stopAssignments = getElementFromElement('stopAssignments', serviceFrame) || serviceFrame.appendChild(xmlDoc.createElement('stopAssignments') as Element);
        // routePoints = getElementFromElement('routePoints', serviceFrame) || serviceFrame.appendChild(xmlDoc.createElement('routePoints') as Element);

        trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
        stops = findStopsForTrips(gtfs, stopIndex, trips, stoptimesIndex);
    }

    const translationsMap: Record<string, Record<string, string>> = getTranslationsMap(gtfs.translations || [], 'stops', 'stop_name');

    for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const parentStop = stopIndex[stop.parent_station];
        const mainStopToUse = parentStop ? parentStop : stop;

        const stopPlaceId = `${stopCs}StopPlace:${mainStopToUse.stop_id}`;
        let stopPlace = stopPlacesMap[stopPlaceId];

        if (!stopPlace) {
            stopPlace = xmlDoc.createElement('StopPlace');
            stopPlace.setAttribute('id', stopPlaceId);
            stopPlace.setAttribute('version', '1');
            stopPlaces.appendChild(stopPlace);

            const nameNode = stopPlace.appendChild(xmlDoc.createElement('Name')) as Element;
            nameNode.textContent = mainStopToUse.stop_name;

            const centroid = stopPlace.appendChild(xmlDoc.createElement('Centroid')) as Element;
            const location = centroid.appendChild(xmlDoc.createElement('Location')) as Element;
            location.appendChild(xmlDoc.createElement('Longitude')).textContent = mainStopToUse.stop_lon.toString();
            location.appendChild(xmlDoc.createElement('Latitude')).textContent = mainStopToUse.stop_lat.toString();

            addAccessibilityAssessment(stopPlace, mainStopToUse.wheelchair_boarding?.toString(), stopCs, `StopPlace_${mainStopToUse.stop_id}`);

            const translations = translationsMap[mainStopToUse.stop_id];
            if (translations) {
                const alternativeNames = stopPlace.appendChild(xmlDoc.createElement('alternativeNames')) as Element;
                for (const [language, translation] of Object.entries(translations)) {
                    const alternativeName = alternativeNames.appendChild(xmlDoc.createElement('AlternativeName')) as Element;
                    alternativeName.setAttribute('id', `${stopCs}AlternativeName:${mainStopToUse.stop_id}:${language}`);
                    alternativeName.setAttribute('version', '1');
                    alternativeName.appendChild(xmlDoc.createElement('NameType')).textContent = 'translation';
                    const name = alternativeName.appendChild(xmlDoc.createElement('Name')) as Element;
                    name.setAttribute('lang', language);
                    name.textContent = translation;
                }
            }

            setTransportModeWithPriority(stopPlace, gtfsRoute.route_type, stopCs);
            stopPlacesMap[stopPlaceId] = stopPlace;
        } else {
            let existingStopPlaceInDocument = getElementFromElement(`.//StopPlace[@id="${stopPlaceId}"]`, stopPlaces as Element);
            if (!existingStopPlaceInDocument) {
                const clonedStopPlace = stopPlace.cloneNode(true) as Element;
                stopPlaces.appendChild(clonedStopPlace);
                setTransportModeWithPriority(clonedStopPlace, gtfsRoute.route_type, stopCs);
                stopPlacesMap[stopPlaceId] = clonedStopPlace;
                stopPlace = clonedStopPlace;
            } else {
                stopPlace = existingStopPlaceInDocument;
                setTransportModeWithPriority(stopPlace, gtfsRoute.route_type, stopCs);
            }
        }

        const locType = stop.location_type;
        if (locType === '0' || !locType) {
            let quays = getElementFromElement('quays', stopPlace) || stopPlace.appendChild(xmlDoc.createElement('quays')) as Element;
            const quayId = `${stopCs}Quay:${stop.stop_id}`;
            let quay = getElementFromElement(`.//Quay[@id="${quayId}"]`, quays);

            if (!quay) {
                quay = xmlDoc.createElement('Quay');
                quay.setAttribute('id', quayId);
                quay.setAttribute('version', '1');
                quays.appendChild(quay);

                quay.appendChild(xmlDoc.createElement('Name')).textContent = stop.stop_name;

                const quayCentroid = quay.appendChild(xmlDoc.createElement('Centroid')) as Element;
                const quayLocation = quayCentroid.appendChild(xmlDoc.createElement('Location')) as Element;
                quayLocation.appendChild(xmlDoc.createElement('Longitude')).textContent = stop.stop_lon.toString();
                quayLocation.appendChild(xmlDoc.createElement('Latitude')).textContent = stop.stop_lat.toString();

                if (stop.stop_code) {
                    quay.appendChild(xmlDoc.createElement('PublicCode')).textContent = stop.stop_code;
                }
            }

            if (!allStopsOnly && stopAssignments && scheduledStopPoints && routePoints) {
                const scheduledStopPointId = `${cs}ScheduledStopPoint:${stop.stop_id}`;
                const scheduledStopPoint = scheduledStopPoints.appendChild(xmlDoc.createElement('ScheduledStopPoint')) as Element;
                scheduledStopPoint.setAttribute('id', scheduledStopPointId);
                scheduledStopPoint.setAttribute('version', '1');
                scheduledStopPoint.appendChild(xmlDoc.createElement('Name')).textContent = stop.stop_name;

                const stopAssignment = stopAssignments.appendChild(xmlDoc.createElement('PassengerStopAssignment')) as Element;
                stopAssignment.setAttribute('id', `${cs}StopAssignment:${stop.stop_id}`);
                stopAssignment.setAttribute('version', '1');
                stopAssignment.setAttribute('order', (i + 1).toString());

                const scheduledRef = stopAssignment.appendChild(xmlDoc.createElement('ScheduledStopPointRef')) as Element;
                scheduledRef.setAttribute('ref', scheduledStopPointId);
                scheduledRef.setAttribute('version', '1');

                const stopPlaceRefEl = stopAssignment.appendChild(xmlDoc.createElement('StopPlaceRef')) as Element;
                stopPlaceRefEl.setAttribute('ref', stopPlaceId);
                stopPlaceRefEl.setAttribute('version', '1');

                const quayRefEl = stopAssignment.appendChild(xmlDoc.createElement('QuayRef')) as Element;
                quayRefEl.setAttribute('ref', quayId);
                quayRefEl.setAttribute('version', '1');

                const routePointId = `${cs}RoutePoint:${stop.stop_id}`;
                const routePoint = routePoints.appendChild(xmlDoc.createElement('RoutePoint')) as Element;
                routePoint.setAttribute('id', routePointId);
                routePoint.setAttribute('version', '1');
                const projections = routePoint.appendChild(xmlDoc.createElement('projections')) as Element;
                const pointProjectionId = `${cs}PointProjection:${stop.stop_id}`;
                const pointProjection = projections.appendChild(xmlDoc.createElement('PointProjection')) as Element;
                pointProjection.setAttribute('id', pointProjectionId);
                pointProjection.setAttribute('version', '1');
                const ptpRef = pointProjection.appendChild(xmlDoc.createElement('ProjectToPointRef')) as Element;
                ptpRef.setAttribute('ref', scheduledStopPointId);
                ptpRef.setAttribute('version', '1');
            }
        }

        stopPlacesMap[stopPlaceId] = stopPlace;
    }
}

function createNetexServiceLinks(
    gtfs: Gtfs,
    xmlDoc: Document,
    gtfsRoute: Route,
    stoptimesIndex: { [trip_id: string]: StopTime[] }
): void {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);
    const serviceFrame = getElementFromDocument('//ServiceFrame', xmlDoc);

    if (!serviceFrame) {
        throw new Error('ServiceFrame not found.');
    }

    const serviceLinks = getElementFromElement('serviceLinks', serviceFrame) || serviceFrame.appendChild(xmlDoc.createElement('serviceLinks'));
    const processedShapes = new Set<string>();
    const tripsForRoute: Trip[] = gtfs.trips.filter((trip) => trip.route_id === gtfsRoute.route_id);

    for (const trip of tripsForRoute) {
        const shapes = gtfs.shapes || [];

        const shape = shapes.find((s) => s.shape_id === trip.shape_id);
        if (!shape || processedShapes.has(shape.shape_id)) {
            continue; // Skip duplicates
        }

        processedShapes.add(shape.shape_id);
        const nShapeId = normalizeGtfsId(shape.shape_id);
        const serviceLinkId = `${cs}ServiceLink:${nShapeId}`;

        const serviceLink = serviceLinks.appendChild(xmlDoc.createElement('ServiceLink')) as Element;
        serviceLink.setAttribute('version', '1');
        serviceLink.setAttribute('id', serviceLinkId);

        const projections = serviceLink.appendChild(xmlDoc.createElement('projections'));
        const linkSequenceProjection = projections.appendChild(xmlDoc.createElement('LinkSequenceProjection')) as Element;
        linkSequenceProjection.setAttribute('version', 'any');
        linkSequenceProjection.setAttribute('id', `${cs}LinkSequenceProjection:${nShapeId}`);

        // Collect all coordinates for this shape
        const coordinates: [number, number][] = shapes
            .filter((s) => s.shape_id === shape.shape_id)
            .map((s) => [s.shape_pt_lat, s.shape_pt_lon]);

        const gmlLineString = linkSequenceProjection.appendChild(xmlDoc.createElement('gml:LineString')) as Element;
        gmlLineString.setAttribute('srsName', 'WGS84');
        gmlLineString.setAttribute('gml:id', `${cs.substr(0, 3)}_LineString_${nShapeId}`);

        for (const [lat, lon] of coordinates) {
            const pos = gmlLineString.appendChild(xmlDoc.createElement('gml:pos'));
            pos.textContent = `${lat} ${lon}`;
        }

        const stopTimes = findStopTimesForTripId(stoptimesIndex, trip.trip_id);

        // Create FromPointRef referencing the first stop
        const firstStopId = _.first(stopTimes)?.stop_id;
        if (firstStopId) {
            const fromPointRef = serviceLink.appendChild(xmlDoc.createElement('FromPointRef')) as Element;
            fromPointRef.setAttribute('version', '1');
            fromPointRef.setAttribute('ref', `${cs}ScheduledStopPoint:${firstStopId}`);
        }

        // Create ToPointRef referencing the last stop
        const lastStopId = _.last(stopTimes)?.stop_id;
        if (lastStopId) {
            const toPointRef = serviceLink.appendChild(xmlDoc.createElement('ToPointRef')) as Element;
            toPointRef.setAttribute('version', '1');
            toPointRef.setAttribute('ref', `${cs}ScheduledStopPoint:${lastStopId}`);
        }
    }

    // Remove empty container element if not allowed by schema
    if (serviceLinks.childNodes.length === 0) {
        serviceFrame.removeChild(serviceLinks);
    }
}

function createNetexJourneys(
    gtfs: Gtfs,
    xmlDoc: Document,
    gtfsRoute: Route,
    dayTypes: { [service_id: string]: Element },
    operator: Element,
    line: Element,
    agency: Agency,
    feedInfo: FeedInfo,
    stoptimesIndex: { [trip_id: string]: StopTime[] },
    stats: Stats,
) {
    const timetableFrame = getElementFromDocument('//TimetableFrame', xmlDoc);
    const serviceFrame = getElementFromDocument('//ServiceFrame', xmlDoc);
    if (!timetableFrame || !serviceFrame) {
        throw new Error('Required elements TimetableFrame or ServiceFrame not found.');
    }

    const journeyPatterns = getElementFromElement('journeyPatterns', serviceFrame) || serviceFrame.appendChild(xmlDoc.createElement('journeyPatterns'));
    const vehicleJourneys = timetableFrame.appendChild(xmlDoc.createElement('vehicleJourneys'));
    const destinationDisplays = getElementFromElement('destinationDisplays', serviceFrame) || serviceFrame.appendChild(xmlDoc.createElement('destinationDisplays'));

    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    const journeyPatternsMap: { [key: string]: Element } = {};
    const destinationDisplaysMap: { [trip_headsign: string]: Element } = {};
    const cs = getCodeSpaceForAgency(agency, feedInfo);

    const tripHeadsignTranslationsMap: Record<string, Record<string, string>> = getTranslationsMap(gtfs.translations || [], 'trips', 'trip_headsign');
    const stopTimesHeadsignTranslationsMap: Record<string, Record<string, string>> = getTranslationsMap(gtfs.translations || [], 'stop_times', 'stop_headsign');

    stats.ServiceJourneys += trips.length;

    for (const trip of trips) {
        const stopTimes = findStopTimesForTripId(stoptimesIndex, trip.trip_id);

        // Build a normalized key for journey pattern grouping
        const stopIds = stopTimes.map((st) => normalizeGtfsId(st.stop_id));
        const key = stopIds.join(',');

        let journeyPattern = journeyPatternsMap[key];

        // Ensure DestinationDisplay for trip headsign (if any)
        if (trip.trip_headsign) {
            const headsignNorm = normalizeGtfsId(trip.trip_headsign);
            const ddId = `${cs}DestinationDisplay:${headsignNorm}`;

            if (!destinationDisplaysMap[ddId]) {
                destinationDisplaysMap[ddId] =
                    createDestinationDisplayForTrip(destinationDisplays as Element, cs, trip, tripHeadsignTranslationsMap, ddId);
            }
        }

        // Create JourneyPattern for this stop sequence (if not already present)
        if (!journeyPattern) {
            // Use normalized key to build a reproducible id for the pattern
            const jpId = `${cs}JourneyPattern:${normalizeGtfsId(trip.trip_id)}`;

            journeyPattern = journeyPatterns.appendChild(xmlDoc.createElement('JourneyPattern')) as Element;
            journeyPattern.setAttribute('id', jpId);
            journeyPattern.setAttribute('version', '1');

            // Ensure JourneyPattern refers to the Route
            const routeRef = xmlDoc.createElement('RouteRef');
            routeRef.setAttribute('ref', `${cs}Route:${normalizeGtfsId(gtfsRoute.route_id)}`);
            routeRef.setAttribute('version', '1');
            journeyPattern.appendChild(routeRef);

            const pis = journeyPattern.appendChild(xmlDoc.createElement('pointsInSequence')) as Element;

            let previousDisplayRef: string | null = null;
            for (let i = 0; i < stopTimes.length; i++) {
                const stopTime = stopTimes[i];

                const spijpId = buildStopPointInJourneyPatternId(cs, jpId, stopTime.stop_id, i);

                const spijp = pis.appendChild(xmlDoc.createElement('StopPointInJourneyPattern')) as Element;
                spijp.setAttribute('id', spijpId);
                spijp.setAttribute('version', '1');
                spijp.setAttribute('order', (i + 1).toString());

                const sspRef = spijp.appendChild(xmlDoc.createElement('ScheduledStopPointRef')) as Element;
                sspRef.setAttribute('ref', `${cs}ScheduledStopPoint:${normalizeGtfsId(stopTime.stop_id)}`);
                sspRef.setAttribute('version', '1');

                if (i === 0) spijp.appendChild(xmlDoc.createElement('ForAlighting')).textContent = 'false';
                if (i === stopTimes.length - 1) spijp.appendChild(xmlDoc.createElement('ForBoarding')).textContent = 'false';

                const headsign = stopTime.stop_headsign || trip.trip_headsign || 'unknown';
                const headsignNorm = normalizeGtfsId(headsign);
                const ddId = `${cs}DestinationDisplay:${headsignNorm}`;
                const isLastStop = (i === stopTimes.length - 1);

                // Always ensure a DestinationDisplayRef on the first SPiJP if we have a headsign
                if (!isLastStop && (i === 0 || ddId !== previousDisplayRef)) {
                    if (!destinationDisplaysMap[ddId]) {
                        destinationDisplaysMap[ddId] =
                            createDestinationDisplayForStopTime(
                                destinationDisplays as Element,
                                cs,
                                stopTime,
                                stopTimesHeadsignTranslationsMap,
                                ddId
                            );
                    }

                    const ddRef = spijp.appendChild(xmlDoc.createElement('DestinationDisplayRef')) as Element;
                    ddRef.setAttribute('version', '1');
                    ddRef.setAttribute('ref', ddId);

                    previousDisplayRef = ddId;
                }
            }

            if (trip.shape_id) {
                const linksInSequence = journeyPattern.appendChild(xmlDoc.createElement('linksInSequence')) as Element;
                const slijp = linksInSequence.appendChild(xmlDoc.createElement('ServiceLinkInJourneyPattern')) as Element;
                slijp.setAttribute('version', '1');
                slijp.setAttribute('id', `${cs}ServiceLinkInJourneyPattern:${normalizeGtfsId(trip.trip_id)}`);
                slijp.setAttribute('order', '1');
                const serviceLinkRef = slijp.appendChild(xmlDoc.createElement('ServiceLinkRef')) as Element;
                serviceLinkRef.setAttribute('version', '1');
                serviceLinkRef.setAttribute('ref', `${cs}ServiceLink:${normalizeGtfsId(trip.shape_id)}`);
            }

            journeyPatternsMap[key] = journeyPattern;
            stats.JourneyPatterns++;
        }

        // Create ServiceJourney
        const serviceJourney = vehicleJourneys.appendChild(xmlDoc.createElement('ServiceJourney')) as Element;
        serviceJourney.setAttribute('id', `${cs}ServiceJourney:${normalizeGtfsId(trip.trip_id)}`);
        serviceJourney.setAttribute('version', '1');
        serviceJourney.appendChild(xmlDoc.createElement('Name')).textContent = gtfsRoute.route_short_name;

        addAccessibilityAssessment(serviceJourney, trip.wheelchair_accessible?.toString(), cs, `ServiceJourney_${trip.trip_id}`);

        // Proper normalized lookup for DayType
        const serviceIdNorm = normalizeServiceId(trip.service_id);
        const dayTypeEl = dayTypes[serviceIdNorm];

        const dayTypesNode = serviceJourney.appendChild(xmlDoc.createElement('dayTypes'));
        const dayTypeRef = dayTypesNode.appendChild(xmlDoc.createElement('DayTypeRef')) as Element;

        if (dayTypeEl) {
            dayTypeRef.setAttribute('ref', dayTypeEl.getAttribute('id') || 'UNKNOWN');
        } else {
            const fallbackDayType = ensureFallbackDayType(xmlDoc, cs);
            dayTypeRef.setAttribute('ref', fallbackDayType.getAttribute('id') || `${cs}DayType:Default`);
            console.warn(
                `GTFS data issue: trip_id=${trip.trip_id} references service_id=${trip.service_id}, ` +
                `but no matching entry was found in calendar.txt or calendar_dates.txt. ` +
                `Using fallback DayType (${dayTypeRef.getAttribute('ref')}).`
            );
        }
        dayTypeRef.setAttribute('version', '1');

        const journeyPatternRef = serviceJourney.appendChild(xmlDoc.createElement('JourneyPatternRef')) as Element;
        journeyPatternRef.setAttribute('ref', journeyPattern.getAttribute('id') || 'UNKNOWN');
        journeyPatternRef.setAttribute('version', '1');

        const operatorRef = serviceJourney.appendChild(xmlDoc.createElement('OperatorRef')) as Element;
        operatorRef.setAttribute('ref', operator.getAttribute('id') || 'UNKNOWN');
        operatorRef.setAttribute('version', '1');

        const lineRef = serviceJourney.appendChild(xmlDoc.createElement('LineRef')) as Element;
        lineRef.setAttribute('ref', line.getAttribute('id') || 'UNKNOWN');
        lineRef.setAttribute('version', '1');

        const passingTimes = serviceJourney.appendChild(xmlDoc.createElement('passingTimes')) as Element;

        for (let i = 0; i < stopTimes.length; i++) {
            const stopTime = stopTimes[i];
            const tpt = passingTimes.appendChild(xmlDoc.createElement('TimetabledPassingTime')) as Element;
            const tptId = `${cs}TimetabledPassingTime:${normalizeGtfsId(trip.trip_id)}_${normalizeGtfsId(stopTime.stop_id)}_${i}`;
            tpt.setAttribute('id', tptId);
            tpt.setAttribute('version', '1');

            const journeyPatternId = journeyPattern.getAttribute('id') || '';
            const spijpId = buildStopPointInJourneyPatternId(cs, journeyPatternId, stopTime.stop_id, i);
            const spijpRef = tpt.appendChild(xmlDoc.createElement('StopPointInJourneyPatternRef')) as Element;
            spijpRef.setAttribute('ref', spijpId);
            spijpRef.setAttribute('version', '1');

            const isFirst = i === 0;
            const isLast = i === stopTimes.length - 1;

            const arrivalRaw = stopTime.arrival_time || null;
            const departureRaw = stopTime.departure_time || null;

            let writeArrival = false;
            let writeDeparture = false;
            let arr: { time: string; dayOffset?: number } | null = null;
            let dep: { time: string; dayOffset?: number } | null = null;

            if (arrivalRaw) arr = formatTime(arrivalRaw);
            if (departureRaw) dep = formatTime(departureRaw);

            if (arrivalRaw && departureRaw && arrivalRaw === departureRaw) {
                if (isLast) {
                    // Last stop must have ArrivalTime → write only ArrivalTime
                    writeArrival = true;
                    writeDeparture = false;
                } else {
                    // Normal case for identical times → only write DepartureTime
                    writeArrival = false;
                    writeDeparture = true;
                }
            } else {
                // Write whatever is available
                writeArrival = !!arr;
                writeDeparture = !!dep;

                // Ensure first stop has a DepartureTime
                if (isFirst && !writeDeparture && writeArrival) {
                    writeDeparture = true;
                    dep = arr;
                }

                // Ensure last stop has an ArrivalTime
                if (isLast && !writeArrival && writeDeparture) {
                    writeArrival = true;
                    arr = dep;
                }
            }

            // Append in correct NeTEx order
            if (writeArrival && arr) {
                const arrivalEl = xmlDoc.createElement('ArrivalTime');
                arrivalEl.textContent = arr.time;
                tpt.appendChild(arrivalEl);

                if (arr.dayOffset !== undefined) {
                    const arrOffsetEl = xmlDoc.createElement('ArrivalDayOffset');
                    arrOffsetEl.textContent = arr.dayOffset.toString();
                    tpt.appendChild(arrOffsetEl);
                }
            }

            if (writeDeparture && dep) {
                const depEl = xmlDoc.createElement('DepartureTime');
                depEl.textContent = dep.time;
                tpt.appendChild(depEl);

                if (dep.dayOffset !== undefined) {
                    const depOffsetEl = xmlDoc.createElement('DepartureDayOffset');
                    depOffsetEl.textContent = dep.dayOffset.toString();
                    tpt.appendChild(depOffsetEl);
                }
            }
        }
    }

    // Remove destinationDisplays if empty (schema compliance)
    if (destinationDisplays.childNodes.length === 0) {
        serviceFrame.removeChild(destinationDisplays);
    }
}
// Validation currently not used
//const xsdContent = fs.readFileSync('./src/netex/xsd/schema/1.03/xsd/NeTEx_publication.xsd', 'utf8');
//const cwd = process.cwd();
//process.chdir(path.dirname("./src/netex/xsd/schema/1.03/xsd/"));
//const xsdDoc = libxmljs.parseXmlString(xsdContent, { baseUrl: "src/netex/xsd/schema/1.03/xsd/" });
//process.chdir(cwd);
//
// function validateNetexDocument(xmlDoc: Document): boolean {
//     const validationResult = xmlDoc.validate(xsdDoc);
//
//     if (!validationResult) {
//         log.error('Validation failed:', xmlDoc.validationErrors);
//     }
//
//     return validationResult;
// }

export {
   writeNeTEx
};

