import {Agency, Gtfs, Route, Stop, StopTime, Trip, FeedInfo, Shape} from "../utils/gtfs-types";
import libxmljs, { Document, Element, Namespace } from "libxmljs2";
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
    getStopPlaceType,
    createDestinationDisplayForTrip,
    createDestinationDisplayForStopTime
} from "./utils";
import { createDayTypesForRoute } from "./daytypes";
import { rootLogger } from "../utils/logger";

const log = rootLogger.child({src: 'netex.ts'});

async function writeNeTEx(gtfs: Gtfs, filePath: string): Promise<string> {
    const stoptimesIndex = indexStopTimesByTripId(gtfs);
    const stopIndex = indexStopsById(gtfs);
    let allStopPlaces: Element[] = []

    const stats: Stats = {} as Stats;
    stats.JourneyPatterns = 0;
    stats.ServiceJourneys = 0;
    stats.Lines = gtfs.routes.length;

    for (let i = 0; i < gtfs.routes.length; i++) {
        const route = gtfs.routes[i];
        const agency = findAgencyForId(gtfs, route.agency_id);
        const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
        const lineId = getNetexLineId(route, agency, feedInfo as FeedInfo);
        log.info('generating netex for route ' + (i + 1) + ' of ' + gtfs.routes.length + ' : ' + lineId);
        const xmlDoc = createNetexDocumentTemplate(false);
        const serviceFrame = xmlDoc.get('//ServiceFrame') as Element;
        const resourceFrame = xmlDoc.get('//ResourceFrame') as Element;
        const serviceCalendarFrame = xmlDoc.get('//ServiceCalendarFrame') as Element;
        const organisations = resourceFrame.get('organisations') as Element;
        const operator = createNetexOperatorFromGtfsRoute(gtfs, organisations, route);
        const line = createNetexLineFromGtfsRoute(gtfs, serviceFrame, route);
        createNetexStops(gtfs, xmlDoc, route, stopIndex, allStopPlaces);
        const dayTypes = createDayTypesForRoute(gtfs, serviceCalendarFrame, route, agency);
        createNetexJourneys(gtfs, xmlDoc, route, dayTypes, operator, line, agency, feedInfo as FeedInfo, stoptimesIndex, stats);
        createNetexServiceLinks(gtfs, xmlDoc, route, stoptimesIndex);
        replaceAttributeContainingString(xmlDoc, 'id', 'perille_', 'Fintraffic_');
        replaceAttributeContainingString(xmlDoc, 'ref', 'perille_', 'Fintraffic_');
        const fileName = _.snakeCase(lineId.replace('perille_', 'Fintraffic_')) + '.xml';
        writeXmlDocToFile(xmlDoc, filePath, fileName);
        log.info('...done.');
    }
    allStopPlaces = _.uniqBy(allStopPlaces, elem => elem.attr('id')?.value());
    stats.StopPlaces = allStopPlaces.length;
    const allStopsDoc = createNetexDocumentTemplate(true);
    const siteFrame = allStopsDoc.get('//SiteFrame') as Element;
    const stopPlaces = siteFrame.node('stopPlaces');
    for (const stopElement of allStopPlaces) {
        stopPlaces.addChild(stopElement.clone());
    }
    stats.Quays = allStopsDoc.find('//Quay').length;
    let publisherName = gtfs.feed_info && gtfs.feed_info[0] && gtfs.feed_info[0].feed_publisher_name;
    publisherName = publisherName?.slice(0, 3).toLowerCase();
    const stopsFileName = publisherName + '_all_stops.xml';
    writeXmlDocToFile(allStopsDoc, filePath, stopsFileName);
    const statsFileName = publisherName + '_stats.json';
    writeStatsToFile(stats, filePath, statsFileName);
    log.info('wrote ' + allStopPlaces.length + ' stop places');
    return '';
}

function createNetexDocumentTemplate(stopsOnly: boolean): Document {
    // Create a new XML document
    const xmlDoc = new libxmljs.Document();

    // Create the PublicationDelivery element (root element)
    const publicationDelivery = xmlDoc
        .node('PublicationDelivery')
        .namespace('http://www.netex.org.uk/netex');
    publicationDelivery.defineNamespace('gml', 'http://www.opengis.net/gml/3.2');

    const publicationTimestamp = publicationDelivery.node('PublicationTimestamp', new Date().toISOString());
    const participantRef = publicationDelivery.node('ParticipantRef', 'FSR');
    const dataObjects = publicationDelivery.node('dataObjects');

    if (stopsOnly) {
        dataObjects.node('SiteFrame').attr({ id: 'SiteFrame_1', version: '1' });
        return xmlDoc;
    }

    // Create the CompositeFrame element and its relevant child elements in correct order
    const compositeFrame = dataObjects.node('CompositeFrame').attr({ id: 'CompositeFrame_1', version: '1' });
    const frameDefaults = compositeFrame.node('FrameDefaults');
    const defaultLocale = frameDefaults.node('DefaultLocale').node('DefaultLanguage', 'fi')
    const defaultLocationSystem = frameDefaults.node('DefaultLocationSystem', 'WGS84');
    const frames = compositeFrame.node('frames');

    const resourceFrame = frames.node('ResourceFrame').attr({ id: 'ResourceFrame_1', version: '1' });
    const organisations = resourceFrame.node('organisations');
    const siteFrame = frames.node('SiteFrame').attr({ id: 'SiteFrame_1', version: '1' });
    const serviceFrame = frames.node('ServiceFrame').attr({ id: 'ServiceFrame_1', version: '1' });
    const lines = serviceFrame.node('lines');
    const destinationDisplays = serviceFrame.node('destinationDisplays');
    const scheduledStopPoints = serviceFrame.node('scheduledStopPoints');
    const serviceLinks = serviceFrame.node('serviceLinks');
    const stopAssignments = serviceFrame.node('stopAssignments');
    const journeyPatterns = serviceFrame.node('journeyPatterns');
    const serviceCalendarFrame = frames.node('ServiceCalendarFrame').attr({ id: 'ServiceCalendarFrame_1', version: '1' });
    const timetableFrame = frames.node('TimetableFrame').attr({ id: 'TimetableFrame_1', version: '1' });

    return xmlDoc;
}

function createNetexOperatorFromGtfsRoute(gtfs: Gtfs, parent: Element, gtfsRoute: Route) : Element {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const operatorElement = parent.node('Operator').attr({ id: getNetexOperatorId(agency), version: '1' });
    operatorElement.node('Name').text(agency.agency_name);
    return operatorElement;
}

function createNetexLineFromGtfsRoute(gtfs: Gtfs, parent: Element, gtfsRoute: Route): Element {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const lines = parent.get('lines') as Element;
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];

    const lineNameTranslationsMap: Record<string, Record<string, string>> = getTranslationsMap(
        gtfs.translations || [],
        'routes',
        'route_long_name'
    );

    // Create the Line element
    const lineElement = lines.node('Line').attr({ id: getNetexLineId(gtfsRoute, agency, feedInfo as FeedInfo), version: '1' });

    // Set the required attributes and elements for the Line element using GTFS route properties
    if (!_.isEmpty(gtfsRoute.route_long_name)) {
        // Check if there are translations for this route name
        if (lineNameTranslationsMap[gtfsRoute.route_id]) {
            const alternativeTexts = lineElement.node('alternativeTexts');
            for (const language in lineNameTranslationsMap[gtfsRoute.route_id]) {
                const translatedName = lineNameTranslationsMap[gtfsRoute.route_id][language];
                const alternativeText = alternativeTexts.node('AlternativeText');
                alternativeText.attr({ attributeName: 'Name'});
                const text = alternativeText.node('Text');
                text.attr({ lang: language });
                text.text(translatedName);
            }
        }
        lineElement.node('Name').text(gtfsRoute.route_long_name);
    }

    lineElement.node('TransportMode').text(getTransportMode(gtfsRoute.route_type));
    if (!_.isEmpty(gtfsRoute.route_short_name)) {
        lineElement.node('PublicCode').text(gtfsRoute.route_short_name);
    }
    lineElement.node('OperatorRef').attr({ ref: getNetexOperatorId(findAgencyForId(gtfs, gtfsRoute.agency_id)), version: '1' }).parent();
    return lineElement; // Return the 'lineElement'
}

const USE_AGENCY_CODESPACES = true; // process.env.USE_AGENCY_CODESPACES === 'true'

// Create the StopPlace and ScheduleStopPoint elements
function createNetexStops(gtfs: Gtfs, xmlDoc: Document, gtfsRoute: Route, stopIndex: { [p: string]: Stop }, allStopPlaces: Element[]) {

    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);
    const stopCs = USE_AGENCY_CODESPACES? cs: 'FSR:';
    const siteFrame = xmlDoc.get('//SiteFrame') as Element;
    const serviceFrame = xmlDoc.get('//ServiceFrame') as Element;
    const stopPlaces = siteFrame.node('stopPlaces');
    const scheduledStopPoints = serviceFrame.get('scheduledStopPoints') as Element;
    const stopAssignments = serviceFrame.get('stopAssignments') as Element;
    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    const stops = findStopsForTrips(gtfs, stopIndex, trips);
    const transportMode = getTransportMode(gtfsRoute.route_type);
    const stopPlacesMap: { [stopPlaceId: string]: Element } = {};
    const translationsMap: Record<string, Record<string, string>> = getTranslationsMap(gtfs.translations || [], 'stops', 'stop_name');

    for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];

        const parentStop = stopIndex[stop.parent_station];
        const mainStopToUse = parentStop ? parentStop : stop;

        // Generate a unique ID for the StopPlace based on the main stop ID
        const stopPlaceId = stopCs + 'StopPlace' + ':' + mainStopToUse.stop_id;
        // Check if the StopPlace has already been created
        let stopPlace = stopPlacesMap[stopPlaceId];
        if (!stopPlace) {
            // Create the StopPlace if it hasn't been created yet
            stopPlace = stopPlaces.node('StopPlace').attr({ id: stopPlaceId, version: '1' });
            stopPlace.node('Name').text(mainStopToUse.stop_name);
            addAccessibilityAssessment(stopPlace, mainStopToUse.wheelchair_boarding?.toString(), stopCs, 'StopPlace_' + mainStopToUse.stop_id);

            // Include translated names if available
            const translations = translationsMap[mainStopToUse.stop_id];
            if (translations) {
                const alternativeNames = stopPlace.node('alternativeNames');
                for (const [language, translation] of Object.entries(translations)) {
                    alternativeNames
                        .node('AlternativeName')
                        .node('NameType')
                        .text('translation')
                        .parent()
                        .node('Name')
                        .attr({ lang: language })
                        .text(translation);
                }
            }
            stopPlace.node('TransportMode').text(getTransportMode(gtfsRoute.route_type));
            const stopPlaceType = getStopPlaceType(gtfsRoute.route_type);
            if (!_.isEmpty(stopPlaceType)) {
                stopPlace.node('StopPlaceType').text(stopPlaceType);
            }

            // Store the created StopPlace in the map
            stopPlacesMap[stopPlaceId] = stopPlace;
            allStopPlaces.push(stopPlace);
        }

        const scheduledStopPointId = cs + 'ScheduledStopPoint' + ':' + stop.stop_id;
        const scheduledStopPoint = scheduledStopPoints.node('ScheduledStopPoint').attr({ id: scheduledStopPointId, version: '1' });
        scheduledStopPoint.node('Name').text(stop.stop_name);

        const stopAssignment = stopAssignments.node('PassengerStopAssignment')
            .attr({ id: cs + 'StopAssignment' + ':' + stop.stop_id, version: '1' });
        stopAssignment.attr({ order: (i + 1).toString() }); // Set the order attribute based on the index
        stopAssignment.node('ScheduledStopPointRef').attr({ ref: scheduledStopPointId, version: '1' });

        // Create the Quay element
        let quays = stopPlace.get('quays') as Element;
        if (!quays) {
            quays = stopPlace.node('quays');
        }
        const quayId = stopCs + 'Quay' + ':' + stop.stop_id;
        const quay = quays.node('Quay').attr({ id: quayId, version: '1' });

        if (!_.isEmpty(stop.stop_digiroad_id)) {
            const keyList = quay.node('keyList');
            keyList.node('KeyValue')
                .node('Key').text('digiroad_id').parent()
                .node('Value').text(stop.stop_digiroad_id);
        }
        if (!_.isEmpty(stop.stop_name)) {
            quay.node('Name').text(stop.stop_name);
        }
        quay.node('Centroid').node('Location')
            .node('Longitude').text(stop.stop_lon.toString()).parent()
            .node('Latitude').text(stop.stop_lat.toString()).parent();

        if (!_.isEmpty(stop.stop_code)) {
            quay.node('PublicCode').text(stop.stop_code);
        }
        stopAssignment.node('StopPlaceRef').attr({ ref: stopPlaceId, version: '1' });
        stopAssignment.node('QuayRef').attr({ ref: quayId, version: '1' });
    }
}

function createNetexServiceLinks(gtfs: Gtfs, xmlDoc: Document, gtfsRoute: Route, stoptimesIndex: { [trip_id: string]: StopTime[] }): void {
    const agency = findAgencyForId(gtfs, gtfsRoute.agency_id);
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);
    const serviceFrame = xmlDoc.get('//ServiceFrame') as Element;
    const serviceLinks = serviceFrame.get('serviceLinks') as Element;

    // Create a set to track unique shape_ids
    const processedShapes = new Set<string>();
    // Find trips associated with the specified route
    const tripsForRoute: Trip[] = gtfs.trips.filter((trip) => trip.route_id === gtfsRoute.route_id);

    for (const trip of tripsForRoute) {
        const shapes = gtfs.shapes || [];

        // Find the shape for the current trip
        const shape: Shape | undefined = shapes.find((s) => s.shape_id === trip.shape_id);

        if (!shape || processedShapes.has(shape.shape_id)) {
            continue; // Skip creating duplicates
        }
        processedShapes.add(shape.shape_id);
        const serviceLinkId  = cs + `ServiceLink:${shape.shape_id}`

        const serviceLink = serviceLinks
            .node('ServiceLink')
            .attr({ version: '1', id: serviceLinkId });

        const projections = serviceLink.node('projections');
        const linkSequenceProjection = projections
            .node('LinkSequenceProjection')
            .attr({ version: 'any', id: cs + `LinkSequenceProjection:${shape.shape_id}` });

        // Collect all coordinates associated with this shape_id
        const coordinates: [number, number][] = shapes
            .filter((s) => s.shape_id === shape.shape_id)
            .map((s) => [s.shape_pt_lat, s.shape_pt_lon]);

        const gmlLineString = linkSequenceProjection
            .node('gml:LineString')
            .attr({ srsName: 'WGS84', 'gml:id': cs.substr(0, 3) + `_LineString_${shape.shape_id}` });

        for (const [lat, lon] of coordinates) {
            gmlLineString.node('gml:pos').text(`${lat} ${lon}`);
        }

        const stopTimes = findStopTimesForTripId(stoptimesIndex, trip.trip_id);

        // Create FromPointRef referencing the first stop
        const firstStopId = _.first(stopTimes)?.stop_id;
        serviceLink.node('FromPointRef').attr({ version: '1', ref: cs + 'ScheduledStopPoint:' + firstStopId });

        // Create ToPointRef referencing the last stop
        const lastStopId = _.last(stopTimes)?.stop_id;
        serviceLink.node('ToPointRef').attr({ version: '1', ref: cs + 'ScheduledStopPoint:' + lastStopId });
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
    const timetableFrame = xmlDoc.get('//TimetableFrame') as Element;
    const serviceFrame = xmlDoc.get('//ServiceFrame') as Element;
    const journeyPatterns = serviceFrame.get('journeyPatterns') as Element;
    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    const tripIds = trips.map(t => t.trip_id);
    const journeyPatternsMap: { [key: string]: Element } = {};
    const vehicleJourneys = timetableFrame.node('vehicleJourneys');
    const destinationDisplaysMap: { [trip_headsign: string]: Element } = {};
    const destinationDisplays = serviceFrame.get('destinationDisplays') as Element;
    const cs = getCodeSpaceForAgency(agency, feedInfo);

    // TODO these could be optimized a bit by precreating these maps as passing them in as arguments
    const tripHeadsignTranslationsMap: Record<string, Record<string, string>> = getTranslationsMap(gtfs.translations || [], 'trips', 'trip_headsign');
    const stopTimesHeadsignTranslationsMap: Record<string, Record<string, string>> = getTranslationsMap(gtfs.translations || [], 'stop_times', 'stop_headsign');

    stats.ServiceJourneys += trips.length;
    for (const trip of trips) {
        const stopTimes = findStopTimesForTripId(stoptimesIndex, trip.trip_id);
        const stopIds = stopTimes.map(st => st.stop_id);
        const key = stopIds.join(',');
        let journeyPattern = journeyPatternsMap[key];

        // Create a DestinationDisplay element if it doesn't exist for this trip_headsign
        if (trip.trip_headsign && !destinationDisplaysMap[trip.trip_headsign]) {
            destinationDisplaysMap[trip.trip_headsign] = createDestinationDisplayForTrip(destinationDisplays, cs, trip, tripHeadsignTranslationsMap);
        }

        // Check if a JourneyPattern with the same sequence of stops already exists
        if (!journeyPattern) {
            journeyPattern = journeyPatterns
                .node('JourneyPattern')
                .attr({id: cs + 'JourneyPattern' + ':' + trip.trip_id, version: '1'});
            const pis = journeyPattern.node('pointsInSequence');

            let previousHeadsign = '';
            for (let i = 0; i < stopTimes.length; i++) {
                const stopTime = stopTimes[i];
                const stopPointId = cs + 'StopPointInJourneyPattern' + ':' + trip.trip_id + ':' + stopTime.stop_id + ':' + i;
                const spijp = pis
                    .node('StopPointInJourneyPattern')
                    .attr({ id: stopPointId, version: '1' })
                    .attr({ order: (i + 1).toString() });

                const scheduledStopPointId = cs + 'ScheduledStopPoint' + ':' + stopTime.stop_id;
                spijp.node('ScheduledStopPointRef').attr({ ref: scheduledStopPointId, version: '1' });

                if (i === 0) {
                    spijp.node('ForAlighting').text('false');
                }

                if (i === stopTimes.length - 1) {
                    spijp.node('ForBoarding').text('false');
                }

                // Create a DestinationDisplayRef if it doesn't exist for this stop_headsign
                if (stopTime.stop_headsign && !destinationDisplaysMap[stopTime.stop_headsign]) {
                    destinationDisplaysMap[stopTime.stop_headsign] = createDestinationDisplayForStopTime(destinationDisplays, cs, stopTime, stopTimesHeadsignTranslationsMap);
                }

                let headsign = stopTime.stop_headsign || trip.trip_headsign;

                // Either first stop or headsign changed
                if (headsign && (i === 0 || headsign !== previousHeadsign)) {
                    const destinationDisplayRef = spijp.node('DestinationDisplayRef');
                    destinationDisplayRef.attr({ version: '1', ref: cs + 'DestinationDisplay:' + headsign });
                    previousHeadsign = headsign;
                }
            }
            if (trip.shape_id) {
                const linksInSequence = journeyPattern.node('linksInSequence');
                const slijp = linksInSequence.node('ServiceLinkInJourneyPattern')
                    .attr({ version: '1', id: cs + 'ServiceLinkInJourneyPattern' + ':' + trip.trip_id, order: '1' });
                slijp.node('ServiceLinkRef').attr({ version: '1', ref: cs + 'ServiceLink' + ':' + trip.shape_id });
            }
            // Store the new JourneyPattern
            journeyPatternsMap[key] = journeyPattern;
            stats.JourneyPatterns++;
        }

        const serviceJourney = vehicleJourneys.node('ServiceJourney').attr({
            id: cs + 'ServiceJourney' + ':' + trip.trip_id,
            version: '1'
        });
        const dayType = dayTypes[trip.service_id];

        serviceJourney.node('Name').text(gtfsRoute.route_short_name);
        addAccessibilityAssessment(serviceJourney, trip.wheelchair_accessible?.toString(), cs, 'ServiceJourney_' + trip.trip_id);
        serviceJourney.node('dayTypes')
            .node('DayTypeRef').attr({ref: dayType?.attr('id')?.value() || 'UNKNOWN', version: '1'});
        serviceJourney.node('JourneyPatternRef').attr({
            ref: journeyPattern.attr('id')?.value() || 'UNKNOWN',
            version: '1'
        });
        serviceJourney.node('OperatorRef').attr({ref: operator.attr('id')?.value() || 'UNKNOWN', version: '1'});
        serviceJourney.node('LineRef').attr({ref: line.attr('id')?.value() || 'UNKNOWN', version: '1'});

        const passingTimes = serviceJourney.node('passingTimes');
        for (let i = 0; i < stopTimes.length; i++) {
            const tpt = passingTimes.node('TimetabledPassingTime').attr({ version: '1' });
            const stopTime = stopTimes[i];

            // Assuming the journeyPattern element's ID is in the format "cs + 'JourneyPattern' + ':' + trip.trip_id"
            const tripIdFromJourneyPattern = _.last(journeyPattern.attr('id')?.value().split(':')); // Extracting trip ID
            const stopPointId = cs + 'StopPointInJourneyPattern' + ':' + tripIdFromJourneyPattern + ':' + stopTime.stop_id + ':' + i;

            tpt.node('StopPointInJourneyPatternRef').attr({ ref: stopPointId, version: '1' });

            const arrivalTime = stopTime.arrival_time;
            const departureTime = stopTime.departure_time;

            if (arrivalTime) {
                const [arrHours, arrMinutes, arrSeconds] = arrivalTime.split(':').map(Number);
                if (arrHours > 23 || (arrHours === 23 && (arrMinutes > 59 || arrSeconds > 59))) {
                    // Arrival time exceeds 23:59:59, calculate the day offset
                    const arrDayOffset = Math.floor(arrHours / 24);
                    const formattedArrTime = `${(arrHours % 24).toString().padStart(2, '0')}:${arrMinutes.toString().padStart(2, '0')}:${arrSeconds.toString().padStart(2, '0')}`;
                    tpt.node('ArrivalTime').text(formattedArrTime);
                    tpt.node('ArrivalDayOffset').text(arrDayOffset.toString());
                } else {
                    tpt.node('ArrivalTime').text(arrivalTime);
                }
            }

            if (departureTime) {
                const [depHours, depMinutes, depSeconds] = departureTime.split(':').map(Number);
                if (depHours > 23 || (depHours === 23 && (depMinutes > 59 || depSeconds > 59))) {
                    // Departure time exceeds 23:59:59, calculate the day offset
                    const depDayOffset = Math.floor(depHours / 24);
                    const formattedDepTime = `${(depHours % 24).toString().padStart(2, '0')}:${depMinutes.toString().padStart(2, '0')}:${depSeconds.toString().padStart(2, '0')}`;
                    tpt.node('DepartureTime').text(formattedDepTime);
                    tpt.node('DepartureDayOffset').text(depDayOffset.toString());
                } else {
                    tpt.node('DepartureTime').text(departureTime);
                }
            }
        }
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

export { writeNeTEx };
