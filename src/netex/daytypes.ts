import { Agency, Calendar, CalendarDateException, Gtfs, Route, FeedInfo } from "../utils/gtfs-types";
import { findCalendarDatesForTrips, findCalendarsForTrips, findTripsForRouteId, getCodeSpaceForAgency } from "./utils";
import _ from "lodash";
import {DateTime} from "ts-luxon";
import { Element } from '@xmldom/xmldom';

function createDayTypesForRoute(
    gtfs: Gtfs,
    parent: Element,
    gtfsRoute: Route,
    agency: Agency
): { [service_id: string]: Element } {
    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    const calendars = findCalendarsForTrips(gtfs, trips);
    const calendarDates = findCalendarDatesForTrips(gtfs, trips);

    const service_ids = Array.from(new Set([...calendars.map(c => c.service_id), ...calendarDates.map(cd => cd.service_id)]));

    // DayTypes, OperatingDays, OperatingPeriods, and Assignments containers
    const doc = parent.ownerDocument!;
    const dayTypes = doc.createElement('dayTypes');
    const operatingDays = doc.createElement('operatingDays');
    const operatingPeriods = doc.createElement('operatingPeriods');
    const dayTypeAssignments = doc.createElement('dayTypeAssignments');

    parent.appendChild(dayTypes);
    parent.appendChild(operatingDays);
    parent.appendChild(operatingPeriods);
    parent.appendChild(dayTypeAssignments);

    const dayTypeElements: { [service_id: string]: Element } = {};
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);

    const operatingDaysById: { [date: string]: Element } = {};

    // Create OperatingDay elements for individual dates from calendarDates
    for (const calendarDate of calendarDates) {
        const isoDate = DateTime.fromFormat(calendarDate.date, 'yyyyMMdd').toISODate() as string;
        if (!operatingDaysById[isoDate]) {
            operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
        }
    }

    // Create OperatingDay elements for services with calendars but no calendarDates
    for (const calendar of calendars) {
        const startDate = DateTime.fromFormat(calendar.start_date, 'yyyyMMdd');
        const endDate = DateTime.fromFormat(calendar.end_date, 'yyyyMMdd');

        for (let date = startDate; date <= endDate; date = date.plus({ days: 1 })) {
            const isoDate = date.toISODate() as string;
            if (!operatingDaysById[isoDate]) {
                operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
            }
        }
    }

    // Create DayType elements for each service_id
    let orderCounter = 1;
    for (const service_id of service_ids) {
        const dayTypeId = `${cs}DayType:${service_id}`;
        const dayType = doc.createElement('DayType');
        dayType.setAttribute('id', dayTypeId);
        dayType.setAttribute('version', '1');
        dayTypes.appendChild(dayType);

        const calendar = calendars.find(c => c.service_id === service_id);

        // If there is a calendar, use it to set the days of the week
        if (calendar) {
            const properties = doc.createElement('properties');
            const propertyOfDay = doc.createElement('PropertyOfDay');
            const daysOfWeek = doc.createElement('DaysOfWeek');
            daysOfWeek.textContent = calendarDaysToString(calendar);

            propertyOfDay.appendChild(daysOfWeek);
            properties.appendChild(propertyOfDay);
            dayType.appendChild(properties);

            const operPeriodId = `${cs}OperatingPeriod:${service_id}`;
            const startDate = DateTime.fromFormat(calendar.start_date, 'yyyyMMdd');
            const endDate = DateTime.fromFormat(calendar.end_date, 'yyyyMMdd');

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

            const dayTypeAssignment = doc.createElement('DayTypeAssignment');
            dayTypeAssignment.setAttribute('id', `${cs}DayTypeAssignment:${calendar.service_id}`);
            dayTypeAssignment.setAttribute('version', '1');
            dayTypeAssignment.setAttribute('order', (orderCounter++).toString());

            const operPeriodRef = doc.createElement('OperatingPeriodRef');
            operPeriodRef.setAttribute('ref', operPeriodId);
            operPeriodRef.setAttribute('version', '1');

            const dayTypeRef = doc.createElement('DayTypeRef');
            dayTypeRef.setAttribute('ref', dayTypeId);
            dayTypeRef.setAttribute('version', '1');

            dayTypeAssignment.appendChild(operPeriodRef);
            dayTypeAssignment.appendChild(dayTypeRef);
            dayTypeAssignments.appendChild(dayTypeAssignment);
        }

        const relatedCalendarDates = calendarDates.filter(cd => cd.service_id === service_id);
        for (let i = 0; i < relatedCalendarDates.length; i++) {
            const calendarDate = relatedCalendarDates[i];
            const isoDate = DateTime.fromFormat(calendarDate.date, 'yyyyMMdd').toISODate() as string;

            if (!operatingDaysById[isoDate]) {
                operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
            }

            const dayTypeAssignment = doc.createElement('DayTypeAssignment');
            dayTypeAssignment.setAttribute('id', `${cs}DayTypeAssignment:${service_id}:${i}`);
            dayTypeAssignment.setAttribute('version', '1');
            dayTypeAssignment.setAttribute('order', (orderCounter++).toString());

            const dateNode = doc.createElement('Date');
            dateNode.textContent = isoDate;

            const dayTypeRef = doc.createElement('DayTypeRef');
            dayTypeRef.setAttribute('ref', dayTypeId);
            dayTypeRef.setAttribute('version', '1');

            const isAvailable = doc.createElement('isAvailable');
            isAvailable.textContent = calendarDate.exception_type == 1 ? 'true' : 'false';

            dayTypeAssignment.appendChild(dateNode);
            dayTypeAssignment.appendChild(dayTypeRef);
            dayTypeAssignment.appendChild(isAvailable);

            dayTypeAssignments.appendChild(dayTypeAssignment);
        }

        dayTypeElements[service_id] = dayType;
    }

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
