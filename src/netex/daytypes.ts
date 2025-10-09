import { Agency, Calendar, CalendarDateException, Gtfs, Route, FeedInfo } from "../utils/gtfs-types";
import {
    findCalendarDatesForTrips,
    findCalendarsForTrips,
    findTripsForRouteId,
    getCodeSpaceForAgency,
    normalizeServiceId,
} from "./utils";
import _ from "lodash";
import {DateTime} from "ts-luxon";
import { Element } from '@xmldom/xmldom';

function createDayTypesForRoute(
    gtfs: Gtfs,
    parent: Element,
    gtfsRoute: Route,
    agency: Agency
): { [service_id: string]: Element } {
    const doc = parent.ownerDocument!;
    const dayTypes = doc.createElement('dayTypes');
    const operatingDays = doc.createElement('operatingDays');
    const operatingPeriods = doc.createElement('operatingPeriods');
    const dayTypeAssignments = doc.createElement('dayTypeAssignments');

    parent.appendChild(dayTypes);
    parent.appendChild(operatingDays);
    parent.appendChild(operatingPeriods);
    parent.appendChild(dayTypeAssignments);

    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    const calendars = findCalendarsForTrips(gtfs, trips);
    const calendarDates = findCalendarDatesForTrips(gtfs, trips);

    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);

    const operatingDaysById: { [isoDate: string]: Element } = {};
    const dayTypeElements: { [service_id: string]: Element } = {};

    // Build service_id set using normalized keys
    const normalizedServiceIds = new Set<string>();
    for (const c of calendars) {
        normalizedServiceIds.add(normalizeServiceId(c.service_id));
    }
    for (const cd of calendarDates) {
        normalizedServiceIds.add(normalizeServiceId(cd.service_id));
    }

    // Pre-generate OperatingDay for every date seen in calendar_dates
    for (const cd of calendarDates) {
        const cdSid = normalizeServiceId(cd.service_id);
        const isoDate = DateTime.fromFormat(cd.date, 'yyyyMMdd').toISODate() as string;
        if (!operatingDaysById[isoDate]) {
            operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
        }
    }

    // Also generate OperatingDays for calendar spans (continuous ranges)
    for (const cal of calendars) {
        const start = DateTime.fromFormat(cal.start_date, 'yyyyMMdd');
        const end = DateTime.fromFormat(cal.end_date, 'yyyyMMdd');
        for (let d = start; d <= end; d = d.plus({ days: 1 })) {
            const isoDate = d.toISODate() as string;
            if (!operatingDaysById[isoDate]) {
                operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
            }
        }
    }

    let orderCounter = 1;

    // Process each normalized service_id
    normalizedServiceIds.forEach((serviceId) => {
        // Create a DayType for each service_id
        const dayTypeId = `${cs}DayType:${serviceId}`;

        const dayType = doc.createElement('DayType');
        dayType.setAttribute('id', dayTypeId);
        dayType.setAttribute('version', '1');
        dayTypes.appendChild(dayType);

        // Find matching "calendar" entry by normalized id (if any)
        const calendar = calendars.find(c => normalizeServiceId(c.service_id) === serviceId);

        // If a calendar exists, set DaysOfWeek + OperatingPeriod
        if (calendar) {
            const properties = doc.createElement('properties');
            const propertyOfDay = doc.createElement('PropertyOfDay');
            const daysOfWeek = doc.createElement('DaysOfWeek');
            daysOfWeek.textContent = calendarDaysToString(calendar);

            propertyOfDay.appendChild(daysOfWeek);
            properties.appendChild(propertyOfDay);
            dayType.appendChild(properties);

            const startDate = DateTime.fromFormat(calendar.start_date, 'yyyyMMdd');
            const endDate = DateTime.fromFormat(calendar.end_date, 'yyyyMMdd');

            const operPeriodId = `${cs}OperatingPeriod:${serviceId}`;
            const operPeriod = doc.createElement('OperatingPeriod');
            operPeriod.setAttribute('id', operPeriodId);
            operPeriod.setAttribute('version', '1');

            const fromOperatingDayRef = doc.createElement('FromOperatingDayRef');
            fromOperatingDayRef.setAttribute('ref', `${cs}OperatingDay:${startDate.toISODate()}`);
            fromOperatingDayRef.setAttribute('version', '1');

            const toOperatingDayRef = doc.createElement('ToOperatingDayRef');
            toOperatingDayRef.setAttribute('ref', `${cs}OperatingDay:${endDate.toISODate()}`);
            toOperatingDayRef.setAttribute('version', '1');

            operPeriod.appendChild(fromOperatingDayRef);
            operPeriod.appendChild(toOperatingDayRef);
            operatingPeriods.appendChild(operPeriod);

            const dta = doc.createElement('DayTypeAssignment');
            dta.setAttribute('id', `${cs}DayTypeAssignment:${serviceId}`);
            dta.setAttribute('version', '1');
            dta.setAttribute('order', (orderCounter++).toString());

            const operPeriodRef = doc.createElement('OperatingPeriodRef');
            operPeriodRef.setAttribute('ref', operPeriodId);
            operPeriodRef.setAttribute('version', '1');

            const dayTypeRef = doc.createElement('DayTypeRef');
            dayTypeRef.setAttribute('ref', dayTypeId);
            dayTypeRef.setAttribute('version', '1');

            dta.appendChild(operPeriodRef);
            dta.appendChild(dayTypeRef);
            dayTypeAssignments.appendChild(dta);
        }

        // Process any calendar_dates for this service_id
        const relatedDates = calendarDates.filter(cd => normalizeServiceId(cd.service_id) === serviceId);
        for (let i = 0; i < relatedDates.length; i++) {
            const cd = relatedDates[i];
            const iso = DateTime.fromFormat(cd.date, 'yyyyMMdd').toISODate() as string;
            if (!operatingDaysById[iso]) {
                operatingDaysById[iso] = createOperatingDay(operatingDays, cs, iso);
            }

            const dta = doc.createElement('DayTypeAssignment');
            dta.setAttribute('id', `${cs}DayTypeAssignment:${serviceId}:${i}`);
            dta.setAttribute('version', '1');
            dta.setAttribute('order', (orderCounter++).toString());

            const dateNode = doc.createElement('Date');
            dateNode.textContent = iso;

            const dtr = doc.createElement('DayTypeRef');
            dtr.setAttribute('ref', dayTypeId);
            dtr.setAttribute('version', '1');

            const isAvailable = doc.createElement('isAvailable');
            isAvailable.textContent = cd.exception_type === 1 ? 'true' : 'false'; // 1=add, 2=remove

            dta.appendChild(dateNode);
            dta.appendChild(dtr);
            dta.appendChild(isAvailable);

            dayTypeAssignments.appendChild(dta);
        }

        // Store the DayType element using normalized service_id as key
        dayTypeElements[serviceId] = dayType;
    });

    // Final cleanup: remove empty containers if nothing was added
    const isEmpty = (el: Element) => !el.hasChildNodes();

    if (isEmpty(dayTypes)) parent.removeChild(dayTypes);
    if (isEmpty(operatingDays)) parent.removeChild(operatingDays);
    if (isEmpty(operatingPeriods)) parent.removeChild(operatingPeriods);
    if (isEmpty(dayTypeAssignments)) parent.removeChild(dayTypeAssignments);

    return dayTypeElements;
}

function createOperatingDay(parent: Element, cs: string, isoDate: string): Element {
    const doc = parent.ownerDocument!;

    // Create the OperatingDay element
    const operatingDay = doc.createElement('OperatingDay');
    operatingDay.setAttribute('id', `${cs}OperatingDay:${isoDate}`);
    operatingDay.setAttribute('version', '1');

    // Create and set CalendarDate
    const calendarDate = doc.createElement('CalendarDate');
    calendarDate.textContent = isoDate;

    // Append CalendarDate to OperatingDay
    operatingDay.appendChild(calendarDate);

    // Append OperatingDay to the parent
    parent.appendChild(operatingDay);

    return operatingDay;
}

function calendarDaysToString(calendar: Calendar): string {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const daysOfWeek = days.filter((day) => calendar[day as keyof Calendar] == 1);
    return daysOfWeek.map(_.capitalize).join(' ');
}

export { createDayTypesForRoute };
