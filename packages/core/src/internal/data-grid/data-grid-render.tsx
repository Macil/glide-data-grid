/* eslint-disable unicorn/no-for-loop */
import {
    type GridSelection,
    type DrawHeaderCallback,
    type InnerGridCell,
    type Rectangle,
    CompactSelection,
    GridColumnIcon,
    type Item,
    type CellList,
    type GridMouseGroupHeaderEventArgs,
    headerCellCheckboxPrefix,
    GridCellKind,
    BooleanIndeterminate,
    headerCellCheckedMarker,
    headerCellUnheckedMarker,
    type TrailingRowType,
    type DrawCellCallback,
    isInnerOnlyCell,
    type GridCell,
} from "./data-grid-types.js";
import { CellSet } from "./cell-set.js";
import groupBy from "lodash/groupBy.js";
import type { HoverValues } from "./animation-manager.js";
import {
    getEffectiveColumns,
    getStickyWidth,
    type MappedGridColumn,
    roundedPoly,
    drawWithLastUpdate,
    isGroupEqual,
    cellIsSelected,
    cellIsInRange,
    computeBounds,
    getMiddleCenterBias,
    rectBottomRight,
} from "./data-grid-lib.js";
import type { SpriteManager, SpriteVariant } from "./data-grid-sprites.js";
import { mergeAndRealizeTheme, type FullTheme, type Theme } from "../../common/styles.js";
import { blend, withAlpha } from "./color-parser.js";
import type { DrawArgs, DrawStateTuple, GetCellRendererCallback, PrepResult } from "../../cells/cell-types.js";
import { assert, deepEqual } from "../../common/support.js";
import { direction } from "../../common/utils.js";
import { drawCheckbox } from "./draw-checkbox.js";
import type { DragAndDropState, DrawGridArg, HoverInfo } from "./draw-grid-arg.js";
import type { EnqueueCallback } from "./use-animation-queue.js";
import type { RenderStateProvider } from "../../common/render-state-provider.js";
import type { ImageWindowLoader } from "./image-window-loader-interface.js";

// Future optimization opportunities
// - Create a cache of a buffer used to render the full view of a partially displayed column so that when
//   scrolling horizontally you can simply blit the pre-drawn column instead of continually paying the draw
//   cost as it slides into view.
// - Blit headers on horizontal scroll
// - Use webworker to load images, helpful with lots of large images
// - Sprite map currently wastes a lot of canvas texture space
// - Retain mode for drawing cells. Instead of drawing cells as we come across them, first build a data
//   structure which contains all operations to perform, then sort them all by "prep" requirement, then do
//   all like operations at once.

export interface Highlight {
    readonly color: string;
    readonly range: Rectangle;
    readonly style?: "dashed" | "solid" | "no-outline" | "solid-outline";
}

interface GroupDetails {
    readonly name: string;
    readonly icon?: string;
    readonly overrideTheme?: Partial<Theme>;
    readonly actions?: readonly {
        readonly title: string;
        readonly onClick: (e: GridMouseGroupHeaderEventArgs) => void;
        readonly icon: GridColumnIcon | string;
    }[];
}

export type GroupDetailsCallback = (groupName: string) => GroupDetails;
export type GetRowThemeCallback = (row: number) => Partial<Theme> | undefined;

const loadingCell: InnerGridCell = {
    kind: GridCellKind.Loading,
    allowOverlay: false,
};

export interface BlitData {
    readonly cellXOffset: number;
    readonly cellYOffset: number;
    readonly translateX: number;
    readonly translateY: number;
    readonly mustDrawFocusOnHeader: boolean;
    readonly lastBuffer: "a" | "b" | undefined;
}

const allocatedItem: [number, number] = [0, 0];
const reusableRect = { x: 0, y: 0, width: 0, height: 0 };
const drawState: DrawStateTuple = [undefined, () => undefined];

let animationFrameRequested = false;
function animRequest(): void {
    animationFrameRequested = true;
}

export function drawCell(
    ctx: CanvasRenderingContext2D,
    row: number,
    cell: InnerGridCell,
    col: number,
    x: number,
    y: number,
    w: number,
    h: number,
    highlighted: boolean,
    theme: FullTheme,
    imageLoader: ImageWindowLoader,
    spriteManager: SpriteManager,
    hoverAmount: number,
    hoverInfo: HoverInfo | undefined,
    hyperWrapping: boolean,
    frameTime: number,
    drawCellCallback: DrawCellCallback | undefined,
    lastPrep: PrepResult | undefined,
    enqueue: EnqueueCallback | undefined,
    renderStateProvider: RenderStateProvider,
    getCellRenderer: GetCellRendererCallback,
    overrideCursor: (cursor: React.CSSProperties["cursor"]) => void
): PrepResult | undefined {
    let hoverX: number | undefined;
    let hoverY: number | undefined;
    if (hoverInfo !== undefined && hoverInfo[0][0] === col && hoverInfo[0][1] === row) {
        hoverX = hoverInfo[1][0];
        hoverY = hoverInfo[1][1];
    }
    let result: PrepResult | undefined = undefined;

    allocatedItem[0] = col;
    allocatedItem[1] = row;

    reusableRect.x = x;
    reusableRect.y = y;
    reusableRect.width = w;
    reusableRect.height = h;

    drawState[0] = renderStateProvider.getValue(allocatedItem);
    drawState[1] = (val: any) => renderStateProvider.setValue(allocatedItem, val); //alloc

    animationFrameRequested = false;

    const args: DrawArgs<typeof cell> = {
        //alloc
        ctx,
        theme,
        col,
        row,
        cell,
        rect: reusableRect,
        highlighted,
        hoverAmount,
        frameTime,
        hoverX,
        drawState,
        hoverY,
        imageLoader,
        spriteManager,
        hyperWrapping,
        overrideCursor: hoverX !== undefined ? overrideCursor : undefined,
        requestAnimationFrame: animRequest,
    };
    const needsAnim = drawWithLastUpdate(args, cell.lastUpdated, frameTime, lastPrep, () => {
        //alloc
        const r = getCellRenderer(cell);
        if (r !== undefined) {
            if (lastPrep?.renderer !== r) {
                lastPrep?.deprep?.(args);
                lastPrep = undefined;
            }
            const partialPrepResult = r.drawPrep?.(args, lastPrep);
            if (drawCellCallback !== undefined && !isInnerOnlyCell(args.cell)) {
                drawCellCallback(args as DrawArgs<GridCell>, () => r.draw(args, cell));
            } else {
                r.draw(args, cell);
            }
            result =
                partialPrepResult === undefined
                    ? undefined
                    : {
                          deprep: partialPrepResult?.deprep,
                          fillStyle: partialPrepResult?.fillStyle,
                          font: partialPrepResult?.font,
                          renderer: r,
                      };
        }
    });
    if (needsAnim || animationFrameRequested) enqueue?.(allocatedItem);
    return result;
}

function blitLastFrame(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    last: BlitData,
    cellXOffset: number,
    cellYOffset: number,
    translateX: number,
    translateY: number,
    lastRowSticky: boolean,
    width: number,
    height: number,
    rows: number,
    totalHeaderHeight: number,
    dpr: number,
    mappedColumns: readonly MappedGridColumn[],
    effectiveCols: readonly MappedGridColumn[],
    getRowHeight: number | ((r: number) => number),
    doubleBuffer: boolean
) {
    const drawRegions: Rectangle[] = [];
    let blittedYOnly = false;

    ctx.imageSmoothingEnabled = false;
    const minY = Math.min(last.cellYOffset, cellYOffset);
    const maxY = Math.max(last.cellYOffset, cellYOffset);
    let deltaY = 0;
    if (typeof getRowHeight === "number") {
        deltaY += (maxY - minY) * getRowHeight;
    } else {
        for (let i = minY; i < maxY; i++) {
            deltaY += getRowHeight(i);
        }
    }
    if (cellYOffset > last.cellYOffset) {
        deltaY = -deltaY;
    }
    deltaY += translateY - last.translateY;

    const minX = Math.min(last.cellXOffset, cellXOffset);
    const maxX = Math.max(last.cellXOffset, cellXOffset);
    let deltaX = 0;
    for (let i = minX; i < maxX; i++) {
        deltaX += mappedColumns[i].width;
    }
    if (cellXOffset > last.cellXOffset) {
        deltaX = -deltaX;
    }
    deltaX += translateX - last.translateX;

    let stickyWidth = getStickyWidth(effectiveCols);
    if (stickyWidth > 0) stickyWidth++;

    if (deltaX !== 0 && deltaY !== 0) {
        return {
            regions: [],
            yOnly: false,
        };
    }

    const stickyRowHeight = lastRowSticky
        ? typeof getRowHeight === "number"
            ? getRowHeight
            : getRowHeight(rows - 1)
        : 0;

    const blitWidth = width - stickyWidth - Math.abs(deltaX);
    const blitHeight = height - totalHeaderHeight - stickyRowHeight - Math.abs(deltaY) - 1;

    if (blitWidth > 150 && blitHeight > 150) {
        blittedYOnly = deltaX === 0;

        const args = {
            sx: 0,
            sy: 0,
            sw: width * dpr,
            sh: height * dpr,
            dx: 0,
            dy: 0,
            dw: width * dpr,
            dh: height * dpr,
        };

        // blit Y
        if (deltaY > 0) {
            // scrolling up
            args.sy = (totalHeaderHeight + 1) * dpr;
            args.sh = blitHeight * dpr;
            args.dy = (deltaY + totalHeaderHeight + 1) * dpr;
            args.dh = blitHeight * dpr;

            drawRegions.push({
                x: 0,
                y: totalHeaderHeight,
                width: width,
                height: deltaY + 1,
            });
        } else if (deltaY < 0) {
            // scrolling down
            args.sy = (-deltaY + totalHeaderHeight + 1) * dpr;
            args.sh = blitHeight * dpr;
            args.dy = (totalHeaderHeight + 1) * dpr;
            args.dh = blitHeight * dpr;

            drawRegions.push({
                x: 0,
                y: height + deltaY - stickyRowHeight,
                width: width,
                height: -deltaY + stickyRowHeight,
            });
        }

        // blit X
        if (deltaX > 0) {
            // pixels moving right
            args.sx = stickyWidth * dpr;
            args.sw = blitWidth * dpr;
            args.dx = (deltaX + stickyWidth) * dpr;
            args.dw = blitWidth * dpr;

            drawRegions.push({
                x: stickyWidth - 1,
                y: 0,
                width: deltaX + 2, // extra width to account for first col not drawing a left side border
                height: height,
            });
        } else if (deltaX < 0) {
            // pixels moving left
            args.sx = (stickyWidth - deltaX) * dpr;
            args.sw = blitWidth * dpr;
            args.dx = stickyWidth * dpr;
            args.dw = blitWidth * dpr;

            drawRegions.push({
                x: width + deltaX,
                y: 0,
                width: -deltaX,
                height: height,
            });
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (stickyWidth > 0 && deltaX !== 0 && deltaY === 0 && doubleBuffer) {
            // When double buffering the freeze columns can be offset by a couple pixels vertically between the two
            // buffers. We don't want to redraw them so we need to make sure to copy them.
            ctx.drawImage(canvas, 0, 0, stickyWidth * dpr, height * dpr, 0, 0, stickyWidth * dpr, height * dpr);
        }
        ctx.drawImage(canvas, args.sx, args.sy, args.sw, args.sh, args.dx, args.dy, args.dw, args.dh);
        ctx.scale(dpr, dpr);
    }
    ctx.imageSmoothingEnabled = true;

    return {
        regions: drawRegions,
        yOnly: blittedYOnly,
    };
}

function blitResizedCol(
    last: BlitData,
    cellXOffset: number,
    cellYOffset: number,
    translateX: number,
    translateY: number,
    width: number,
    height: number,
    totalHeaderHeight: number,
    effectiveCols: readonly MappedGridColumn[],
    resizedIndex: number
) {
    const drawRegions: Rectangle[] = [];

    // ctx.imageSmoothingEnabled = false;

    if (
        cellXOffset !== last.cellXOffset ||
        cellYOffset !== last.cellYOffset ||
        translateX !== last.translateX ||
        translateY !== last.translateY
    ) {
        return drawRegions;
    }

    walkColumns(effectiveCols, cellYOffset, translateX, translateY, totalHeaderHeight, (c, drawX, _drawY, clipX) => {
        if (c.sourceIndex === resizedIndex) {
            const x = Math.max(drawX, clipX) + 1;
            drawRegions.push({
                x,
                y: 0,
                width: width - x,
                height,
            });
            return true;
        }
    });
    return drawRegions;
}

// lines are effectively drawn on the top left edge of a cell.
function drawGridLines(
    ctx: CanvasRenderingContext2D,
    effectiveCols: readonly MappedGridColumn[],
    cellYOffset: number,
    translateX: number,
    translateY: number,
    width: number,
    height: number,
    drawRegions: Rectangle[] | undefined,
    spans: Rectangle[] | undefined,
    groupHeaderHeight: number,
    totalHeaderHeight: number,
    getRowHeight: (row: number) => number,
    getRowThemeOverride: GetRowThemeCallback | undefined,
    verticalBorder: (col: number) => boolean,
    trailingRowType: TrailingRowType,
    rows: number,
    theme: FullTheme,
    verticalOnly: boolean = false
) {
    if (spans !== undefined) {
        ctx.beginPath();
        ctx.save();
        ctx.rect(0, 0, width, height);
        for (const span of spans) {
            ctx.rect(span.x + 1, span.y + 1, span.width - 1, span.height - 1);
        }
        ctx.clip("evenodd");
    }
    const hColor = theme.horizontalBorderColor ?? theme.borderColor;
    const vColor = theme.borderColor;

    let minX = 0;
    let maxX = width;
    let minY = 0;
    let maxY = height;

    if (drawRegions !== undefined && drawRegions.length > 0) {
        minX = Number.MAX_SAFE_INTEGER;
        minY = Number.MAX_SAFE_INTEGER;
        maxX = Number.MIN_SAFE_INTEGER;
        maxY = Number.MIN_SAFE_INTEGER;
        for (const r of drawRegions) {
            minX = Math.min(minX, r.x - 1);
            maxX = Math.max(maxX, r.x + r.width + 1);
            minY = Math.min(minY, r.y - 1);
            maxY = Math.max(maxY, r.y + r.height + 1);
        }
    }

    const toDraw: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];

    ctx.beginPath();

    // vertical lines
    let x = 0.5;
    for (let index = 0; index < effectiveCols.length; index++) {
        const c = effectiveCols[index];
        if (c.width === 0) continue;
        x += c.width;
        const tx = c.sticky ? x : x + translateX;
        if (tx >= minX && tx <= maxX && verticalBorder(index + 1)) {
            toDraw.push({
                x1: tx,
                y1: Math.max(groupHeaderHeight, minY),
                x2: tx,
                y2: Math.min(height, maxY),
                color: vColor,
            });
        }
    }

    const stickyHeight = getRowHeight(rows - 1);
    const stickyRowY = height - stickyHeight + 0.5;
    const lastRowSticky = trailingRowType === "sticky";
    if (lastRowSticky) {
        toDraw.push({ x1: minX, y1: stickyRowY, x2: maxX, y2: stickyRowY, color: hColor });
    }

    if (verticalOnly !== true) {
        // horizontal lines
        let y = totalHeaderHeight + 0.5;
        let row = cellYOffset;
        const target = lastRowSticky ? height - stickyHeight : height;
        while (y + translateY <= target) {
            const ty = y + translateY;
            // This shouldn't be needed it seems like... yet it is. We're not sure why.
            if (ty >= minY && ty <= maxY - 1 && (!lastRowSticky || row !== rows - 1 || Math.abs(ty - stickyRowY) > 1)) {
                const rowTheme = getRowThemeOverride?.(row);
                toDraw.push({
                    x1: minX,
                    y1: ty,
                    x2: maxX,
                    y2: ty,
                    color: rowTheme?.horizontalBorderColor ?? rowTheme?.borderColor ?? hColor,
                });
            }

            y += getRowHeight(row);
            row++;
        }
    }

    const groups = groupBy(toDraw, line => line.color);
    for (const g of Object.keys(groups)) {
        ctx.strokeStyle = g;
        for (const line of groups[g]) {
            ctx.moveTo(line.x1, line.y1);
            ctx.lineTo(line.x2, line.y2);
        }
        ctx.stroke();
        ctx.beginPath();
    }

    if (spans !== undefined) {
        ctx.restore();
    }
}

export function getActionBoundsForGroup(
    box: Rectangle,
    actions: NonNullable<GroupDetails["actions"]>
): readonly Rectangle[] {
    const result: Rectangle[] = [];
    let x = box.x + box.width - 26 * actions.length;
    const y = box.y + box.height / 2 - 13;
    const height = 26;
    const width = 26;
    for (let i = 0; i < actions.length; i++) {
        result.push({
            x,
            y,
            width,
            height,
        });
        x += 26;
    }
    return result;
}

export function pointInRect(rect: Rectangle, x: number, y: number): boolean {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function drawGroups(
    ctx: CanvasRenderingContext2D,
    effectiveCols: readonly MappedGridColumn[],
    width: number,
    translateX: number,
    groupHeaderHeight: number,
    hovered: HoverInfo | undefined,
    theme: FullTheme,
    spriteManager: SpriteManager,
    _hoverValues: HoverValues,
    verticalBorder: (col: number) => boolean,
    getGroupDetails: GroupDetailsCallback,
    damage: CellSet | undefined
) {
    const xPad = 8;
    const [hCol, hRow] = hovered?.[0] ?? [];

    let finalX = 0;
    walkGroups(effectiveCols, width, translateX, groupHeaderHeight, (span, groupName, x, y, w, h) => {
        if (
            damage !== undefined &&
            !damage.hasItemInRectangle({
                x: span[0],
                y: -2,
                width: span[1] - span[0] + 1,
                height: 1,
            })
        )
            return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();

        const group = getGroupDetails(groupName);
        const groupTheme =
            group?.overrideTheme === undefined ? theme : mergeAndRealizeTheme(theme, group.overrideTheme);
        const isHovered = hRow === -2 && hCol !== undefined && hCol >= span[0] && hCol <= span[1];

        const fillColor = isHovered ? groupTheme.bgHeaderHovered : groupTheme.bgHeader;
        if (fillColor !== theme.bgHeader) {
            ctx.fillStyle = fillColor;
            ctx.fill();
        }

        ctx.fillStyle = groupTheme.textGroupHeader ?? groupTheme.textHeader;
        if (group !== undefined) {
            let drawX = x;
            if (group.icon !== undefined) {
                spriteManager.drawSprite(
                    group.icon,
                    "normal",
                    ctx,
                    drawX + xPad,
                    (groupHeaderHeight - 20) / 2,
                    20,
                    groupTheme
                );
                drawX += 26;
            }
            ctx.fillText(
                group.name,
                drawX + xPad,
                groupHeaderHeight / 2 + getMiddleCenterBias(ctx, theme.headerFontFull)
            );

            if (group.actions !== undefined && isHovered) {
                const actionBoxes = getActionBoundsForGroup({ x, y, width: w, height: h }, group.actions);

                ctx.beginPath();
                const fadeStartX = actionBoxes[0].x - 10;
                const fadeWidth = x + w - fadeStartX;
                ctx.rect(fadeStartX, 0, fadeWidth, groupHeaderHeight);
                const grad = ctx.createLinearGradient(fadeStartX, 0, fadeStartX + fadeWidth, 0);
                const trans = withAlpha(fillColor, 0);
                grad.addColorStop(0, trans);
                grad.addColorStop(10 / fadeWidth, fillColor);
                grad.addColorStop(1, fillColor);
                ctx.fillStyle = grad;

                ctx.fill();

                ctx.globalAlpha = 0.6;

                // eslint-disable-next-line prefer-const
                const [mouseX, mouseY] = hovered?.[1] ?? [-1, -1];
                for (let i = 0; i < group.actions.length; i++) {
                    const action = group.actions[i];
                    const box = actionBoxes[i];
                    const actionHovered = pointInRect(box, mouseX + x, mouseY);
                    if (actionHovered) {
                        ctx.globalAlpha = 1;
                    }
                    spriteManager.drawSprite(
                        action.icon,
                        "normal",
                        ctx,
                        box.x + box.width / 2 - 10,
                        box.y + box.height / 2 - 10,
                        20,
                        groupTheme
                    );
                    if (actionHovered) {
                        ctx.globalAlpha = 0.6;
                    }
                }

                ctx.globalAlpha = 1;
            }
        }

        if (x !== 0 && verticalBorder(span[0])) {
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, groupHeaderHeight);
            ctx.strokeStyle = theme.borderColor;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        ctx.restore();

        finalX = x + w;
    });

    ctx.beginPath();
    ctx.moveTo(finalX + 0.5, 0);
    ctx.lineTo(finalX + 0.5, groupHeaderHeight);

    ctx.moveTo(0, groupHeaderHeight + 0.5);
    ctx.lineTo(width, groupHeaderHeight + 0.5);
    ctx.strokeStyle = theme.borderColor;
    ctx.lineWidth = 1;
    ctx.stroke();
}

const menuButtonSize = 30;
export function getHeaderMenuBounds(x: number, y: number, width: number, height: number, isRtl: boolean): Rectangle {
    if (isRtl) return { x, y, width: menuButtonSize, height: Math.min(menuButtonSize, height) };
    return {
        x: x + width - menuButtonSize, // right align
        y: Math.max(y, y + height / 2 - menuButtonSize / 2), // center vertically
        width: menuButtonSize,
        height: Math.min(menuButtonSize, height),
    };
}

function drawHeaderInner(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    c: MappedGridColumn,
    selected: boolean,
    theme: FullTheme,
    isHovered: boolean,
    hoverAmount: number,
    spriteManager: SpriteManager,
    touchMode: boolean,
    isRtl: boolean,
    isCheckboxHeader: boolean,
    menuBounds: Rectangle
) {
    if (isCheckboxHeader) {
        let checked: boolean | BooleanIndeterminate = undefined;
        if (c.title === headerCellCheckedMarker) checked = true;
        if (c.title === headerCellUnheckedMarker) checked = false;
        if (checked !== true) {
            ctx.globalAlpha = hoverAmount;
        }
        drawCheckbox(ctx, theme, checked, x, y, width, height, false, undefined, undefined, 18);
        if (checked !== true) {
            ctx.globalAlpha = 1;
        }
        return;
    }

    const xPad = theme.cellHorizontalPadding;
    const fillStyle = selected ? theme.textHeaderSelected : theme.textHeader;

    const shouldDrawMenu = c.hasMenu === true && (isHovered || (touchMode && selected));

    const dirScalar = isRtl ? -1 : 1;

    let drawX = isRtl ? x + width - xPad : x + xPad;
    if (c.icon !== undefined) {
        let variant: SpriteVariant = selected ? "selected" : "normal";
        if (c.style === "highlight") {
            variant = selected ? "selected" : "special";
        }
        const headerSize = theme.headerIconSize;
        spriteManager.drawSprite(
            c.icon,
            variant,
            ctx,
            isRtl ? drawX - headerSize : drawX,
            y + (height - headerSize) / 2,
            headerSize,
            theme
        );

        if (c.overlayIcon !== undefined) {
            spriteManager.drawSprite(
                c.overlayIcon,
                selected ? "selected" : "special",
                ctx,
                isRtl ? drawX - headerSize + 9 : drawX + 9,
                y + ((height - 18) / 2 + 6),
                18,
                theme
            );
        }

        drawX += Math.ceil(headerSize * 1.3) * dirScalar;
    }

    if (shouldDrawMenu && c.hasMenu === true && width > 35) {
        const fadeWidth = 35;
        const fadeStart = isRtl ? fadeWidth : width - fadeWidth;
        const fadeEnd = isRtl ? fadeWidth * 0.7 : width - fadeWidth * 0.7;

        const fadeStartPercent = fadeStart / width;
        const fadeEndPercent = fadeEnd / width;

        const grad = ctx.createLinearGradient(x, 0, x + width, 0);
        const trans = withAlpha(fillStyle, 0);

        grad.addColorStop(isRtl ? 1 : 0, fillStyle);
        grad.addColorStop(fadeStartPercent, fillStyle);
        grad.addColorStop(fadeEndPercent, trans);
        grad.addColorStop(isRtl ? 0 : 1, trans);
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = fillStyle;
    }

    if (isRtl) {
        ctx.textAlign = "right";
    }
    ctx.fillText(c.title, drawX, y + height / 2 + getMiddleCenterBias(ctx, theme.headerFontFull));
    if (isRtl) {
        ctx.textAlign = "left";
    }

    if (shouldDrawMenu && c.hasMenu === true) {
        ctx.beginPath();
        const triangleX = menuBounds.x + menuBounds.width / 2 - 5.5;
        const triangleY = menuBounds.y + menuBounds.height / 2 - 3;
        roundedPoly(
            ctx,
            [
                {
                    x: triangleX,
                    y: triangleY,
                },
                {
                    x: triangleX + 11,
                    y: triangleY,
                },
                {
                    x: triangleX + 5.5,
                    y: triangleY + 6,
                },
            ],
            1
        );

        ctx.fillStyle = fillStyle;
        ctx.fill();
    }
}

export function drawHeader(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    c: MappedGridColumn,
    selected: boolean,
    theme: FullTheme,
    isHovered: boolean,
    hasSelectedCell: boolean,
    hoverAmount: number,
    spriteManager: SpriteManager,
    drawHeaderCallback: DrawHeaderCallback | undefined,
    touchMode: boolean
) {
    const isCheckboxHeader = c.title.startsWith(headerCellCheckboxPrefix);
    const isRtl = direction(c.title) === "rtl";
    const menuBounds = getHeaderMenuBounds(x, y, width, height, isRtl);

    if (drawHeaderCallback !== undefined) {
        let passCol = c;
        if (isCheckboxHeader) {
            passCol = {
                ...c,
                title: "",
            };
        }
        drawHeaderCallback(
            {
                ctx,
                theme,
                rect: { x, y, width, height },
                column: passCol,
                columnIndex: passCol.sourceIndex,
                isSelected: selected,
                hoverAmount,
                isHovered,
                hasSelectedCell,
                spriteManager,
                menuBounds,
            },
            () =>
                drawHeaderInner(
                    ctx,
                    x,
                    y,
                    width,
                    height,
                    c,
                    selected,
                    theme,
                    isHovered,
                    hoverAmount,
                    spriteManager,
                    touchMode,
                    isRtl,
                    isCheckboxHeader,
                    menuBounds
                )
        );
    } else {
        drawHeaderInner(
            ctx,
            x,
            y,
            width,
            height,
            c,
            selected,
            theme,
            isHovered,
            hoverAmount,
            spriteManager,
            touchMode,
            isRtl,
            isCheckboxHeader,
            menuBounds
        );
    }
}

function drawGridHeaders(
    ctx: CanvasRenderingContext2D,
    effectiveCols: readonly MappedGridColumn[],
    enableGroups: boolean,
    hovered: HoverInfo | undefined,
    width: number,
    translateX: number,
    headerHeight: number,
    groupHeaderHeight: number,
    dragAndDropState: DragAndDropState | undefined,
    isResizing: boolean,
    selection: GridSelection,
    outerTheme: FullTheme,
    spriteManager: SpriteManager,
    hoverValues: HoverValues,
    verticalBorder: (col: number) => boolean,
    getGroupDetails: GroupDetailsCallback,
    damage: CellSet | undefined,
    drawHeaderCallback: DrawHeaderCallback | undefined,
    touchMode: boolean
) {
    const totalHeaderHeight = headerHeight + groupHeaderHeight;
    if (totalHeaderHeight <= 0) return;

    ctx.fillStyle = outerTheme.bgHeader;
    ctx.fillRect(0, 0, width, totalHeaderHeight);

    const [hCol, hRow] = hovered?.[0] ?? [];

    const font = outerTheme.headerFontFull;
    // Assinging the context font too much can be expensive, it can be worth it to minimze this
    ctx.font = font;
    walkColumns(effectiveCols, 0, translateX, 0, totalHeaderHeight, (c, x, _y, clipX) => {
        if (damage !== undefined && !damage.has([c.sourceIndex, -1])) return;
        const diff = Math.max(0, clipX - x);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + diff, groupHeaderHeight, c.width - diff, headerHeight);
        ctx.clip();

        const groupTheme = getGroupDetails(c.group ?? "").overrideTheme;
        const theme =
            c.themeOverride === undefined && groupTheme === undefined
                ? outerTheme
                : mergeAndRealizeTheme(outerTheme, groupTheme, c.themeOverride);

        if (theme.bgHeader !== outerTheme.bgHeader) {
            ctx.fillStyle = theme.bgHeader;
            ctx.fill();
        }

        if (theme !== outerTheme) {
            ctx.font = theme.baseFontFull;
        }
        const selected = selection.columns.hasIndex(c.sourceIndex);
        const noHover = dragAndDropState !== undefined || isResizing;
        const hoveredBoolean = !noHover && hRow === -1 && hCol === c.sourceIndex;
        const hover = noHover
            ? 0
            : hoverValues.find(s => s.item[0] === c.sourceIndex && s.item[1] === -1)?.hoverAmount ?? 0;

        const hasSelectedCell = selection?.current !== undefined && selection.current.cell[0] === c.sourceIndex;

        const bgFillStyle = selected ? theme.accentColor : hasSelectedCell ? theme.bgHeaderHasFocus : theme.bgHeader;

        const y = enableGroups ? groupHeaderHeight : 0;
        const xOffset = c.sourceIndex === 0 ? 0 : 1;

        if (selected) {
            ctx.fillStyle = bgFillStyle;
            ctx.fillRect(x + xOffset, y, c.width - xOffset, headerHeight);
        } else if (hasSelectedCell || hover > 0) {
            ctx.beginPath();
            ctx.rect(x + xOffset, y, c.width - xOffset, headerHeight);
            if (hasSelectedCell) {
                ctx.fillStyle = theme.bgHeaderHasFocus;
                ctx.fill();
            }
            if (hover > 0) {
                ctx.globalAlpha = hover;
                ctx.fillStyle = theme.bgHeaderHovered;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }

        drawHeader(
            ctx,
            x,
            y,
            c.width,
            headerHeight,
            c,
            selected,
            theme,
            hoveredBoolean,
            hasSelectedCell,
            hover,
            spriteManager,
            drawHeaderCallback,
            touchMode
        );
        ctx.restore();
    });

    if (enableGroups) {
        drawGroups(
            ctx,
            effectiveCols,
            width,
            translateX,
            groupHeaderHeight,
            hovered,
            outerTheme,
            spriteManager,
            hoverValues,
            verticalBorder,
            getGroupDetails,
            damage
        );
    }
}

function intersectRect(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number) {
    return x1 <= x2 + w2 && x2 <= x1 + w1 && y1 <= y2 + h2 && y2 <= y1 + h1;
}

function clipDamage(
    ctx: CanvasRenderingContext2D,
    effectiveColumns: readonly MappedGridColumn[],
    width: number,
    height: number,
    groupHeaderHeight: number,
    totalHeaderHeight: number,
    translateX: number,
    translateY: number,
    cellYOffset: number,
    rows: number,
    getRowHeight: (row: number) => number,
    trailingRowType: TrailingRowType,
    damage: CellSet | undefined,
    includeCells: boolean
): void {
    if (damage === undefined || damage.size === 0) return;

    const stickyRowHeight = trailingRowType === "sticky" ? getRowHeight(rows - 1) : 0;

    ctx.beginPath();

    walkGroups(effectiveColumns, width, translateX, groupHeaderHeight, (span, _group, x, y, w, h) => {
        const hasItemInSpan = damage.hasItemInRectangle({
            x: span[0],
            y: -2,
            width: span[1] - span[0] + 1,
            height: 1,
        });
        if (hasItemInSpan) {
            ctx.rect(x, y, w, h);
        }
    });

    walkColumns(
        effectiveColumns,
        cellYOffset,
        translateX,
        translateY,
        totalHeaderHeight,
        (c, drawX, colDrawY, clipX, startRow) => {
            const diff = Math.max(0, clipX - drawX);

            const finalX = drawX + diff + 1;
            const finalWidth = c.width - diff - 1;
            if (damage.has([c.sourceIndex, -1])) {
                ctx.rect(finalX, groupHeaderHeight, finalWidth, totalHeaderHeight - groupHeaderHeight);
            }

            if (!includeCells) return;

            walkRowsInCol(
                startRow,
                colDrawY,
                height,
                rows,
                getRowHeight,
                trailingRowType,
                (drawY, row, rh, isSticky) => {
                    const isDamaged = damage.has([c.sourceIndex, row]);
                    if (isDamaged) {
                        const top = drawY + 1;
                        const bottom = isSticky ? top + rh - 1 : Math.min(top + rh - 1, height - stickyRowHeight);
                        const h = bottom - top;

                        if (h > 0) {
                            ctx.rect(finalX, top, finalWidth, h);
                        }
                    }
                }
            );
        }
    );
    ctx.clip();
}

function getSpanBounds(
    span: Item,
    cellX: number,
    cellY: number,
    cellW: number,
    cellH: number,
    column: MappedGridColumn,
    allColumns: readonly MappedGridColumn[]
): [Rectangle | undefined, Rectangle | undefined] {
    const [startCol, endCol] = span;

    let frozenRect: Rectangle | undefined;
    let contentRect: Rectangle | undefined;

    const firstNonSticky = allColumns.find(x => !x.sticky)?.sourceIndex ?? 0;
    if (endCol > firstNonSticky) {
        const renderFromCol = Math.max(startCol, firstNonSticky);
        let tempX = cellX;
        let tempW = cellW;
        for (let x = column.sourceIndex - 1; x >= renderFromCol; x--) {
            tempX -= allColumns[x].width;
            tempW += allColumns[x].width;
        }
        for (let x = column.sourceIndex + 1; x <= endCol; x++) {
            tempW += allColumns[x].width;
        }
        contentRect = {
            x: tempX,
            y: cellY,
            width: tempW,
            height: cellH,
        };
    }

    if (firstNonSticky > startCol) {
        const renderToCol = Math.min(endCol, firstNonSticky - 1);
        let tempX = cellX;
        let tempW = cellW;
        for (let x = column.sourceIndex - 1; x >= startCol; x--) {
            tempX -= allColumns[x].width;
            tempW += allColumns[x].width;
        }
        for (let x = column.sourceIndex + 1; x <= renderToCol; x++) {
            tempW += allColumns[x].width;
        }
        frozenRect = {
            x: tempX,
            y: cellY,
            width: tempW,
            height: cellH,
        };
    }

    return [frozenRect, contentRect];
}

// preppable items:
// - font
// - fillStyle

// Column draw loop prep cycle
// - Prep item
// - Prep sets props
// - Prep returns list of cared about props
// - Draw item
// - Loop may set some items, if present in args list, set undefined
// - Prep next item, giving previous result
// - If next item type is different, de-prep
// - Result per column
function drawCells(
    ctx: CanvasRenderingContext2D,
    effectiveColumns: readonly MappedGridColumn[],
    allColumns: readonly MappedGridColumn[],
    height: number,
    totalHeaderHeight: number,
    translateX: number,
    translateY: number,
    cellYOffset: number,
    rows: number,
    getRowHeight: (row: number) => number,
    getCellContent: (cell: Item) => InnerGridCell,
    getGroupDetails: GroupDetailsCallback,
    getRowThemeOverride: GetRowThemeCallback | undefined,
    disabledRows: CompactSelection,
    isFocused: boolean,
    drawFocus: boolean,
    trailingRowType: TrailingRowType,
    drawRegions: readonly Rectangle[],
    damage: CellSet | undefined,
    selection: GridSelection,
    prelightCells: CellList | undefined,
    highlightRegions: readonly Highlight[] | undefined,
    imageLoader: ImageWindowLoader,
    spriteManager: SpriteManager,
    hoverValues: HoverValues,
    hoverInfo: HoverInfo | undefined,
    drawCellCallback: DrawCellCallback | undefined,
    hyperWrapping: boolean,
    outerTheme: FullTheme,
    enqueue: EnqueueCallback,
    renderStateProvider: RenderStateProvider,
    getCellRenderer: GetCellRendererCallback,
    overrideCursor: (cursor: React.CSSProperties["cursor"]) => void,
    minimumCellWidth: number
): Rectangle[] | undefined {
    let toDraw = damage?.size ?? Number.MAX_SAFE_INTEGER;
    const frameTime = performance.now();
    let font = outerTheme.baseFontFull;
    ctx.font = font;
    const deprepArg = { ctx };
    const cellIndex: [number, number] = [0, 0];
    let result: Rectangle[] | undefined;
    const handledSpans = new Set<string>();
    walkColumns(
        effectiveColumns,
        cellYOffset,
        translateX,
        translateY,
        totalHeaderHeight,
        (c, drawX, colDrawStartY, clipX, startRow) => {
            const diff = Math.max(0, clipX - drawX);

            const colDrawX = drawX + diff;
            const colDrawY = totalHeaderHeight + 1;
            const colWidth = c.width - diff;
            const colHeight = height - totalHeaderHeight - 1;
            if (drawRegions.length > 0) {
                let found = false;
                for (let i = 0; i < drawRegions.length; i++) {
                    const dr = drawRegions[i];
                    if (intersectRect(colDrawX, colDrawY, colWidth, colHeight, dr.x, dr.y, dr.width, dr.height)) {
                        found = true;
                        break;
                    }
                }
                if (!found) return;
            }

            const reclip = () => {
                ctx.save();
                ctx.beginPath();
                ctx.rect(colDrawX, colDrawY, colWidth, colHeight);
                ctx.clip();
            };

            const colSelected = selection.columns.hasIndex(c.sourceIndex);

            const groupTheme = getGroupDetails(c.group ?? "").overrideTheme;
            const colTheme =
                c.themeOverride === undefined && groupTheme === undefined
                    ? outerTheme
                    : mergeAndRealizeTheme(outerTheme, groupTheme, c.themeOverride);
            const colFont = colTheme.baseFontFull;
            if (colFont !== font) {
                font = colFont;
                ctx.font = colFont;
            }
            reclip();
            let prepResult: PrepResult | undefined = undefined;

            walkRowsInCol(
                startRow,
                colDrawStartY,
                height,
                rows,
                getRowHeight,
                trailingRowType,
                (drawY, row, rh, isSticky, isTrailingRow) => {
                    if (row < 0) return;

                    cellIndex[0] = c.sourceIndex;
                    cellIndex[1] = row;
                    // if (damage !== undefined && !damage.some(d => d[0] === c.sourceIndex && d[1] === row)) {
                    //     return;
                    // }
                    // if (
                    //     drawRegions.length > 0 &&
                    //     !drawRegions.some(dr => intersectRect(drawX, drawY, c.width, rh, dr.x, dr.y, dr.width, dr.height))
                    // ) {
                    //     return;
                    // }

                    // These are dumb versions of the above. I cannot for the life of believe that this matters but this is
                    // the tightest part of the draw loop and the allocations above actually has a very measurable impact
                    // on performance. For the love of all that is unholy please keep checking this again in the future.
                    // As soon as this doesn't have any impact of note go back to the saner looking code. The smoke test
                    // here is to scroll to the bottom of a test case first, then scroll back up while profiling and see
                    // how many major GC collections you get. These allocate a lot of objects.
                    if (damage !== undefined && !damage.has(cellIndex)) {
                        return;
                    }
                    if (drawRegions.length > 0) {
                        let found = false;
                        for (let i = 0; i < drawRegions.length; i++) {
                            const dr = drawRegions[i];
                            if (intersectRect(drawX, drawY, c.width, rh, dr.x, dr.y, dr.width, dr.height)) {
                                found = true;
                                break;
                            }
                        }
                        if (!found) return;
                    }

                    const rowSelected = selection.rows.hasIndex(row);
                    const rowDisabled = disabledRows.hasIndex(row);

                    const cell: InnerGridCell = row < rows ? getCellContent(cellIndex) : loadingCell;

                    let cellX = drawX;
                    let cellWidth = c.width;
                    let drawingSpan = false;
                    let skipContents = false;
                    if (cell.span !== undefined) {
                        const [startCol, endCol] = cell.span;
                        const spanKey = `${row},${startCol},${endCol},${c.sticky}`; //alloc
                        if (!handledSpans.has(spanKey)) {
                            const areas = getSpanBounds(cell.span, drawX, drawY, c.width, rh, c, allColumns);
                            const area = c.sticky ? areas[0] : areas[1];
                            if (!c.sticky && areas[0] !== undefined) {
                                skipContents = true;
                            }
                            if (area !== undefined) {
                                cellX = area.x;
                                cellWidth = area.width;
                                handledSpans.add(spanKey);
                                ctx.restore();
                                prepResult = undefined;
                                ctx.save();
                                ctx.beginPath();
                                const d = Math.max(0, clipX - area.x);
                                ctx.rect(area.x + d, drawY, area.width - d, rh);
                                if (result === undefined) {
                                    result = [];
                                }
                                result.push({
                                    x: area.x + d,
                                    y: drawY,
                                    width: area.width - d,
                                    height: rh,
                                });
                                ctx.clip();
                                drawingSpan = true;
                            }
                        } else {
                            toDraw--;
                            return;
                        }
                    }

                    const rowTheme = getRowThemeOverride?.(row);
                    const trailingTheme =
                        isTrailingRow && c.trailingRowOptions?.themeOverride !== undefined
                            ? c.trailingRowOptions?.themeOverride
                            : undefined;
                    const theme =
                        cell.themeOverride === undefined && rowTheme === undefined && trailingTheme === undefined
                            ? colTheme
                            : mergeAndRealizeTheme(colTheme, rowTheme, trailingTheme, cell.themeOverride); //alloc

                    ctx.beginPath();

                    const isSelected = cellIsSelected(cellIndex, cell, selection);
                    let accentCount = cellIsInRange(cellIndex, cell, selection);
                    const spanIsHighlighted =
                        cell.span !== undefined &&
                        selection.columns.some(
                            index => cell.span !== undefined && index >= cell.span[0] && index <= cell.span[1] //alloc
                        );
                    if (isSelected && !isFocused && drawFocus) {
                        accentCount = 0;
                    } else if (isSelected) {
                        accentCount = Math.max(accentCount, 1);
                    }
                    if (spanIsHighlighted) {
                        accentCount++;
                    }
                    if (!isSelected) {
                        if (rowSelected) accentCount++;
                        if (colSelected && !isSticky) accentCount++;
                    }

                    const bgCell = cell.kind === GridCellKind.Protected ? theme.bgCellMedium : theme.bgCell;
                    let fill: string | undefined;
                    if (isSticky || bgCell !== outerTheme.bgCell) {
                        fill = blend(bgCell, fill);
                    }

                    if (accentCount > 0 || rowDisabled) {
                        if (rowDisabled) {
                            fill = blend(theme.bgHeader, fill);
                        }
                        for (let i = 0; i < accentCount; i++) {
                            fill = blend(theme.accentLight, fill);
                        }
                    } else if (prelightCells !== undefined) {
                        for (const pre of prelightCells) {
                            if (pre[0] === c.sourceIndex && pre[1] === row) {
                                fill = blend(theme.bgSearchResult, fill);
                                break;
                            }
                        }
                    }

                    if (highlightRegions !== undefined) {
                        for (let i = 0; i < highlightRegions.length; i++) {
                            const region = highlightRegions[i];
                            const r = region.range;
                            if (
                                region.style !== "solid-outline" &&
                                r.x <= c.sourceIndex &&
                                c.sourceIndex < r.x + r.width &&
                                r.y <= row &&
                                row < r.y + r.height
                            ) {
                                fill = blend(region.color, fill);
                            }
                        }
                    }

                    if (fill !== undefined) {
                        ctx.fillStyle = fill;
                        if (prepResult !== undefined) {
                            prepResult.fillStyle = fill;
                        }
                        if (damage !== undefined) {
                            ctx.fillRect(cellX + 1, drawY + 1, cellWidth - 1, rh - 1);
                        } else {
                            ctx.fillRect(cellX, drawY, cellWidth, rh);
                        }
                    }

                    if (cell.style === "faded") {
                        ctx.globalAlpha = 0.6;
                    }

                    let hoverValue: HoverValues[number] | undefined;
                    for (let i = 0; i < hoverValues.length; i++) {
                        const hv = hoverValues[i];
                        if (hv.item[0] === c.sourceIndex && hv.item[1] === row) {
                            hoverValue = hv;
                            break;
                        }
                    }

                    if (cellWidth > minimumCellWidth && !skipContents) {
                        const cellFont = theme.baseFontFull;
                        if (cellFont !== font) {
                            ctx.font = cellFont;
                            font = cellFont;
                        }
                        prepResult = drawCell(
                            ctx,
                            row,
                            cell,
                            c.sourceIndex,
                            cellX,
                            drawY,
                            cellWidth,
                            rh,
                            accentCount > 0,
                            theme,
                            imageLoader,
                            spriteManager,
                            hoverValue?.hoverAmount ?? 0,
                            hoverInfo,
                            hyperWrapping,
                            frameTime,
                            drawCellCallback,
                            prepResult,
                            enqueue,
                            renderStateProvider,
                            getCellRenderer,
                            overrideCursor
                        );
                    }

                    if (cell.style === "faded") {
                        ctx.globalAlpha = 1;
                    }
                    toDraw--;
                    if (drawingSpan) {
                        ctx.restore();
                        prepResult?.deprep?.(deprepArg);
                        prepResult = undefined;
                        reclip();
                        font = colFont;
                        ctx.font = colFont;
                    }
                    return toDraw <= 0;
                }
            );

            ctx.restore();
            return toDraw <= 0;
        }
    );
    return result;
}

function drawBlanks(
    ctx: CanvasRenderingContext2D,
    effectiveColumns: readonly MappedGridColumn[],
    allColumns: readonly MappedGridColumn[],
    width: number,
    height: number,
    totalHeaderHeight: number,
    translateX: number,
    translateY: number,
    cellYOffset: number,
    rows: number,
    getRowHeight: (row: number) => number,
    getRowTheme: GetRowThemeCallback | undefined,
    selectedRows: CompactSelection,
    disabledRows: CompactSelection,
    trailingRowType: TrailingRowType,
    drawRegions: readonly Rectangle[],
    damage: CellSet | undefined,
    theme: FullTheme
): void {
    if (
        damage !== undefined ||
        effectiveColumns[effectiveColumns.length - 1] !== allColumns[effectiveColumns.length - 1]
    )
        return;
    walkColumns(
        effectiveColumns,
        cellYOffset,
        translateX,
        translateY,
        totalHeaderHeight,
        (c, drawX, colDrawY, clipX, startRow) => {
            if (c !== effectiveColumns[effectiveColumns.length - 1]) return;
            drawX += c.width;
            const x = Math.max(drawX, clipX);
            if (x > width) return;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, totalHeaderHeight + 1, 10_000, height - totalHeaderHeight - 1);
            ctx.clip();

            walkRowsInCol(
                startRow,
                colDrawY,
                height,
                rows,
                getRowHeight,
                trailingRowType,
                (drawY, row, rh, isSticky) => {
                    if (
                        !isSticky &&
                        drawRegions.length > 0 &&
                        !drawRegions.some(dr =>
                            intersectRect(drawX, drawY, 10_000, rh, dr.x, dr.y, dr.width, dr.height)
                        )
                    ) {
                        return;
                    }

                    const rowSelected = selectedRows.hasIndex(row);
                    const rowDisabled = disabledRows.hasIndex(row);

                    ctx.beginPath();

                    const rowTheme = getRowTheme?.(row);

                    const blankTheme = rowTheme === undefined ? theme : mergeAndRealizeTheme(theme, rowTheme);

                    if (blankTheme.bgCell !== theme.bgCell) {
                        ctx.fillStyle = blankTheme.bgCell;
                        ctx.fillRect(drawX, drawY, 10_000, rh);
                    }
                    if (rowDisabled) {
                        ctx.fillStyle = blankTheme.bgHeader;
                        ctx.fillRect(drawX, drawY, 10_000, rh);
                    }
                    if (rowSelected) {
                        ctx.fillStyle = blankTheme.accentLight;
                        ctx.fillRect(drawX, drawY, 10_000, rh);
                    }
                }
            );

            ctx.restore();
        }
    );
}

function overdrawStickyBoundaries(
    ctx: CanvasRenderingContext2D,
    effectiveCols: readonly MappedGridColumn[],
    width: number,
    height: number,
    lastRowSticky: boolean,
    rows: number,
    verticalBorder: (col: number) => boolean,
    getRowHeight: (row: number) => number,
    theme: FullTheme
) {
    let drawFreezeBorder = false;
    for (const c of effectiveCols) {
        if (c.sticky) continue;
        drawFreezeBorder = verticalBorder(c.sourceIndex);
        break;
    }
    const hColor = theme.horizontalBorderColor ?? theme.borderColor;
    const vColor = theme.borderColor;
    const drawX = drawFreezeBorder ? getStickyWidth(effectiveCols) : 0;

    if (drawX !== 0) {
        ctx.beginPath();
        ctx.moveTo(drawX + 0.5, 0);
        ctx.lineTo(drawX + 0.5, height);
        ctx.strokeStyle = blend(vColor, theme.bgCell);
        ctx.stroke();
    }

    if (lastRowSticky) {
        const h = getRowHeight(rows - 1);
        ctx.beginPath();
        ctx.moveTo(0, height - h + 0.5);
        ctx.lineTo(width, height - h + 0.5);
        ctx.strokeStyle = blend(hColor, theme.bgCell);
        ctx.stroke();
    }
}

function drawHighlightRings(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    cellXOffset: number,
    cellYOffset: number,
    translateX: number,
    translateY: number,
    mappedColumns: readonly MappedGridColumn[],
    freezeColumns: number,
    headerHeight: number,
    groupHeaderHeight: number,
    rowHeight: number | ((index: number) => number),
    lastRowSticky: boolean,
    rows: number,
    allHighlightRegions: readonly Highlight[] | undefined
): (() => void) | undefined {
    const highlightRegions = allHighlightRegions?.filter(x => x.style !== "no-outline");

    if (highlightRegions === undefined || highlightRegions.length === 0) return undefined;
    const drawRects = highlightRegions.map(h => {
        const r = h.range;
        const topLeftBounds = computeBounds(
            r.x,
            r.y,
            width,
            height,
            groupHeaderHeight,
            headerHeight + groupHeaderHeight,
            cellXOffset,
            cellYOffset,
            translateX,
            translateY,
            rows,
            freezeColumns,
            lastRowSticky,
            mappedColumns,
            rowHeight
        );
        if (r.width === 1 && r.height === 1) {
            if (r.x < freezeColumns) {
                return [{ color: h.color, style: h.style ?? "dashed", rect: topLeftBounds }, undefined];
            }
            return [undefined, { color: h.color, style: h.style ?? "dashed", rect: topLeftBounds }];
        }

        const bottomRightBounds = computeBounds(
            r.x + r.width - 1,
            r.y + r.height - 1,
            width,
            height,
            groupHeaderHeight,
            headerHeight + groupHeaderHeight,
            cellXOffset,
            cellYOffset,
            translateX,
            translateY,
            rows,
            freezeColumns,
            lastRowSticky,
            mappedColumns,
            rowHeight
        );
        if (r.x < freezeColumns && r.x + r.width >= freezeColumns) {
            const freezeSectionRightBounds = computeBounds(
                freezeColumns - 1,
                r.y + r.height - 1,
                width,
                height,
                groupHeaderHeight,
                headerHeight + groupHeaderHeight,
                cellXOffset,
                cellYOffset,
                translateX,
                translateY,
                rows,
                freezeColumns,
                lastRowSticky,
                mappedColumns,
                rowHeight
            );
            const unfreezeSectionleftBounds = computeBounds(
                freezeColumns,
                r.y,
                width,
                height,
                groupHeaderHeight,
                headerHeight + groupHeaderHeight,
                cellXOffset,
                cellYOffset,
                translateX,
                translateY,
                rows,
                freezeColumns,
                lastRowSticky,
                mappedColumns,
                rowHeight
            );

            return [
                {
                    color: h.color,
                    style: h.style ?? "dashed",
                    rect: {
                        x: topLeftBounds.x,
                        y: topLeftBounds.y,
                        width: freezeSectionRightBounds.x + freezeSectionRightBounds.width - topLeftBounds.x,
                        height: freezeSectionRightBounds.y + freezeSectionRightBounds.height - topLeftBounds.y,
                    } as Rectangle,
                },
                {
                    color: h.color,
                    style: h.style ?? "dashed",
                    rect: {
                        x: unfreezeSectionleftBounds.x,
                        y: unfreezeSectionleftBounds.y,
                        width: bottomRightBounds.x + bottomRightBounds.width - unfreezeSectionleftBounds.x,
                        height: bottomRightBounds.y + bottomRightBounds.height - unfreezeSectionleftBounds.y,
                    } as Rectangle,
                },
            ];
        } else {
            return [
                undefined,
                {
                    color: h.color,
                    style: h.style ?? "dashed",
                    rect: {
                        x: topLeftBounds.x,
                        y: topLeftBounds.y,
                        width: bottomRightBounds.x + bottomRightBounds.width - topLeftBounds.x,
                        height: bottomRightBounds.y + bottomRightBounds.height - topLeftBounds.y,
                    } as Rectangle,
                },
            ];
        }
    });

    const stickyWidth = getStickyWidth(mappedColumns);

    const drawCb = () => {
        ctx.beginPath();
        ctx.save();
        let dashed = false;
        const setDashed = (dash: boolean) => {
            if (dashed === dash) return;
            ctx.setLineDash(dash ? [5, 3] : []);
            dashed = dash;
        };

        ctx.lineWidth = 1;
        for (const dr of drawRects) {
            const [s] = dr;
            if (
                s !== undefined &&
                intersectRect(0, 0, width, height, s.rect.x, s.rect.y, s.rect.width, s.rect.height)
            ) {
                setDashed(s.style === "dashed");
                ctx.strokeStyle = withAlpha(s.color, 1);
                ctx.strokeRect(s.rect.x + 0.5, s.rect.y + 0.5, s.rect.width - 1, s.rect.height - 1);
            }
        }
        let clipped = false;
        for (const dr of drawRects) {
            const [, s] = dr;
            if (
                s !== undefined &&
                intersectRect(0, 0, width, height, s.rect.x, s.rect.y, s.rect.width, s.rect.height)
            ) {
                setDashed(s.style === "dashed");
                if (!clipped && s.rect.x < stickyWidth) {
                    ctx.rect(stickyWidth, 0, width, height);
                    ctx.clip();
                    clipped = true;
                }
                ctx.strokeStyle = s.style === "solid-outline" ? s.color : withAlpha(s.color, 1);
                ctx.strokeRect(s.rect.x + 0.5, s.rect.y + 0.5, s.rect.width - 1, s.rect.height - 1);
            }
        }
        ctx.restore();
    };

    drawCb();
    return drawCb;
}

function drawColumnResizeOutline(
    ctx: CanvasRenderingContext2D,
    yOffset: number,
    xOffset: number,
    height: number,
    theme: FullTheme
) {
    ctx.beginPath();
    ctx.moveTo(yOffset, xOffset);
    ctx.lineTo(yOffset, height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.accentColor;

    ctx.stroke();

    ctx.globalAlpha = 1;
}

function drawFocusRing(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    cellYOffset: number,
    translateX: number,
    translateY: number,
    effectiveCols: readonly MappedGridColumn[],
    allColumns: readonly MappedGridColumn[],
    theme: FullTheme,
    totalHeaderHeight: number,
    selectedCell: GridSelection,
    getRowHeight: (row: number) => number,
    getCellContent: (cell: Item) => InnerGridCell,
    trailingRowType: TrailingRowType,
    fillHandle: boolean,
    fillHandleLocation: "selected-cell" | "selected-range",
    rows: number
): (() => void) | undefined {
    if (selectedCell.current === undefined) return undefined;

    const range = selectedCell.current.range;
    const currentItem = selectedCell.current.cell;
    const fillHandleTarget =
        fillHandleLocation === "selected-cell"
            ? selectedCell.current.cell
            : [range.x + range.width - 1, range.y + range.height - 1];
    const mustDraw = effectiveCols.some(c => c.sourceIndex === currentItem[0] || c.sourceIndex === fillHandleTarget[0]);

    if (!mustDraw) return undefined;
    const [targetCol, targetRow] = selectedCell.current.cell;
    const cell = getCellContent(selectedCell.current.cell);
    const targetColSpan = cell.span ?? [targetCol, targetCol];

    const isStickyRow = trailingRowType === "sticky" && targetRow === rows - 1;
    const stickRowHeight = trailingRowType === "sticky" && !isStickyRow ? getRowHeight(rows - 1) - 1 : 0;

    const fillHandleRow = fillHandleTarget[1];

    let drawCb: (() => void) | undefined = undefined;
    let drawHandleCb: (() => void) | undefined = undefined;

    walkColumns(
        effectiveCols,
        cellYOffset,
        translateX,
        translateY,
        totalHeaderHeight,
        (col, drawX, colDrawY, clipX, startRow) => {
            if (col.sticky && targetCol > col.sourceIndex) return;

            const isBeforeTarget = col.sourceIndex < targetColSpan[0];
            const isAfterTarget = col.sourceIndex > targetColSpan[1];

            const isFillHandleCol = col.sourceIndex === fillHandleTarget[0];

            if (!isFillHandleCol && (isBeforeTarget || isAfterTarget)) {
                // we dont need to do any drawing on this column but may yet need to draw
                return;
            }

            walkRowsInCol(startRow, colDrawY, height, rows, getRowHeight, trailingRowType, (drawY, row, rh) => {
                if (row !== targetRow && row !== fillHandleRow) return;

                let cellX = drawX;
                let cellWidth = col.width;

                if (cell.span !== undefined) {
                    const areas = getSpanBounds(cell.span, drawX, drawY, col.width, rh, col, allColumns);
                    const area = col.sticky ? areas[0] : areas[1];

                    if (area !== undefined) {
                        cellX = area.x;
                        cellWidth = area.width;
                    }
                }

                const doHandle = row === fillHandleRow && isFillHandleCol && fillHandle;
                const doRing = row === targetRow && !isBeforeTarget && !isAfterTarget && drawCb === undefined;

                if (doHandle) {
                    drawHandleCb = () => {
                        if (clipX > cellX && !col.sticky && !doRing) {
                            ctx.beginPath();
                            ctx.rect(clipX, 0, width - clipX, height);
                            ctx.clip();
                        }
                        ctx.beginPath();
                        ctx.rect(cellX + cellWidth - 4, drawY + rh - 4, 4, 4);
                        ctx.fillStyle = col.themeOverride?.accentColor ?? theme.accentColor;
                        ctx.fill();
                    };
                }

                if (doRing) {
                    drawCb = () => {
                        if (clipX > cellX && !col.sticky) {
                            ctx.beginPath();
                            ctx.rect(clipX, 0, width - clipX, height);
                            ctx.clip();
                        }
                        ctx.beginPath();
                        ctx.rect(cellX + 0.5, drawY + 0.5, cellWidth, rh);
                        ctx.strokeStyle = col.themeOverride?.accentColor ?? theme.accentColor;
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    };
                }
                return drawCb !== undefined && (fillHandle ? drawHandleCb !== undefined : true);
            });

            return drawCb !== undefined && (fillHandle ? drawHandleCb !== undefined : true);
        }
    );

    if (drawCb === undefined && drawHandleCb === undefined) return undefined;

    const result = () => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, totalHeaderHeight, width, height - totalHeaderHeight - stickRowHeight);
        ctx.clip();

        drawCb?.();
        drawHandleCb?.();

        ctx.restore();
    };

    result();

    return result;
}

function getLastRow(
    effectiveColumns: readonly MappedGridColumn[],
    height: number,
    totalHeaderHeight: number,
    translateX: number,
    translateY: number,
    cellYOffset: number,
    rows: number,
    getRowHeight: (row: number) => number,
    trailingRowType: TrailingRowType
): number {
    let result = 0;
    walkColumns(
        effectiveColumns,
        cellYOffset,
        translateX,
        translateY,
        totalHeaderHeight,
        (_c, __drawX, colDrawY, _clipX, startRow) => {
            walkRowsInCol(
                startRow,
                colDrawY,
                height,
                rows,
                getRowHeight,
                trailingRowType,
                (_drawY, row, _rh, isSticky) => {
                    if (!isSticky) {
                        result = Math.max(row, result);
                    }
                }
            );

            return true;
        }
    );
    return result;
}

function computeCanBlit(current: DrawGridArg, last: DrawGridArg | undefined): boolean | number {
    if (last === undefined) return false;
    if (
        current.width !== last.width ||
        current.height !== last.height ||
        current.theme !== last.theme ||
        current.headerHeight !== last.headerHeight ||
        current.rowHeight !== last.rowHeight ||
        current.rows !== last.rows ||
        current.getRowThemeOverride !== last.getRowThemeOverride ||
        current.isFocused !== last.isFocused ||
        current.isResizing !== last.isResizing ||
        current.verticalBorder !== last.verticalBorder ||
        current.getCellContent !== last.getCellContent ||
        current.highlightRegions !== last.highlightRegions ||
        current.selection !== last.selection ||
        current.dragAndDropState !== last.dragAndDropState ||
        current.prelightCells !== last.prelightCells ||
        current.touchMode !== last.touchMode ||
        current.fillHandleLocation !== last.fillHandleLocation ||
        current.scrolling !== last.scrolling
    ) {
        return false;
    }
    if (current.mappedColumns !== last.mappedColumns) {
        if (current.mappedColumns.length > 100 || current.mappedColumns.length !== last.mappedColumns.length) {
            // The array is big, let's just redraw the damned thing rather than check these all. Or the number of cols
            // changed in which case I dont want to figure out what happened.
            return false;
        }
        // We want to know if only one column has resized. If this is the case we can do a special left/right sliding
        // blit. Or just not redraw shit on the left.
        let resized: number | undefined;
        for (let i = 0; i < current.mappedColumns.length; i++) {
            const curCol = current.mappedColumns[i];
            const lastCol = last.mappedColumns[i];

            if (deepEqual(curCol, lastCol)) continue;

            // two columns changed, abort
            if (resized !== undefined) return false;

            if (curCol.width === lastCol.width) return false;

            const { width, ...curRest } = curCol;
            const { width: lastWidth, ...lastRest } = lastCol;

            // more than width changed, abort
            if (!deepEqual(curRest, lastRest)) return false;
            resized = i;
        }
        if (resized === undefined) {
            // we never found a changed column, cool, we can blit
            return true;
        }
        return resized;
    }
    return true;
}

export function drawGrid(arg: DrawGridArg, lastArg: DrawGridArg | undefined) {
    const {
        canvas,
        headerCanvas,
        width,
        height,
        cellXOffset,
        cellYOffset,
        translateX,
        translateY,
        mappedColumns,
        enableGroups,
        freezeColumns,
        dragAndDropState,
        theme,
        drawFocus,
        headerHeight,
        groupHeaderHeight,
        disabledRows,
        rowHeight,
        verticalBorder,
        overrideCursor,
        isResizing,
        selection,
        fillHandle,
        fillHandleLocation,
        lastRowSticky: trailingRowType,
        rows,
        getCellContent,
        getGroupDetails,
        getRowThemeOverride,
        isFocused,
        drawHeaderCallback,
        prelightCells,
        drawCellCallback,
        highlightRegions,
        resizeCol,
        imageLoader,
        lastBlitData,
        hoverValues,
        hyperWrapping,
        hoverInfo,
        spriteManager,
        scrolling,
        touchMode,
        enqueue,
        renderStateProvider,
        getCellRenderer,
        renderStrategy,
        bufferA,
        bufferB,
        damage,
        minimumCellWidth,
    } = arg;
    if (width === 0 || height === 0) return;
    const doubleBuffer = renderStrategy === "double-buffer";
    const dpr = scrolling ? 1 : Math.ceil(window.devicePixelRatio ?? 1);

    const canBlit = renderStrategy !== "direct" && computeCanBlit(arg, lastArg);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;

        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
    }

    const overlayCanvas = headerCanvas;
    const totalHeaderHeight = enableGroups ? groupHeaderHeight + headerHeight : headerHeight;

    const overlayHeight = totalHeaderHeight + 1; // border
    if (overlayCanvas.width !== width * dpr || overlayCanvas.height !== overlayHeight * dpr) {
        overlayCanvas.width = width * dpr;
        overlayCanvas.height = overlayHeight * dpr;

        overlayCanvas.style.width = width + "px";
        overlayCanvas.style.height = overlayHeight + "px";
    }

    if (doubleBuffer && (bufferA.width !== width * dpr || bufferA.height !== height * dpr)) {
        bufferA.width = width * dpr;
        bufferA.height = height * dpr;
    }

    if (doubleBuffer && (bufferB.width !== width * dpr || bufferB.height !== height * dpr)) {
        bufferB.width = width * dpr;
        bufferB.height = height * dpr;
    }

    const last = lastBlitData.current;
    if (
        canBlit === true &&
        cellXOffset === last?.cellXOffset &&
        cellYOffset === last?.cellYOffset &&
        translateX === last?.translateX &&
        translateY === last?.translateY
    )
        return;

    let mainCtx: CanvasRenderingContext2D | null = null;
    if (doubleBuffer) {
        mainCtx = canvas.getContext("2d", {
            alpha: false,
        });
    }
    const overlayCtx = overlayCanvas.getContext("2d", {
        alpha: false,
    });
    let targetBuffer: HTMLCanvasElement;
    if (!doubleBuffer) {
        targetBuffer = canvas;
    } else if (damage !== undefined) {
        targetBuffer = last?.lastBuffer === "b" ? bufferB : bufferA;
    } else {
        targetBuffer = last?.lastBuffer === "b" ? bufferA : bufferB;
    }
    const targetCtx = targetBuffer.getContext("2d", {
        alpha: false,
    });
    const blitSource = doubleBuffer ? (targetBuffer === bufferA ? bufferB : bufferA) : canvas;

    if (overlayCtx === null || targetCtx === null) return;

    const getRowHeight = typeof rowHeight === "number" ? () => rowHeight : rowHeight;

    overlayCtx.save();
    overlayCtx.beginPath();
    targetCtx.save();
    targetCtx.beginPath();

    overlayCtx.textBaseline = "middle";
    targetCtx.textBaseline = "middle";

    if (dpr !== 1) {
        overlayCtx.scale(dpr, dpr);
        targetCtx.scale(dpr, dpr);
    }

    const effectiveCols = getEffectiveColumns(mappedColumns, cellXOffset, width, dragAndDropState, translateX);

    let drawRegions: Rectangle[] = [];

    const mustDrawFocusOnHeader = drawFocus && selection.current?.cell[1] === cellYOffset && translateY === 0;
    const drawHeaderTexture = () => {
        drawGridHeaders(
            overlayCtx,
            effectiveCols,
            enableGroups,
            hoverInfo,
            width,
            translateX,
            headerHeight,
            groupHeaderHeight,
            dragAndDropState,
            isResizing,
            selection,
            theme,
            spriteManager,
            hoverValues,
            verticalBorder,
            getGroupDetails,
            damage,
            drawHeaderCallback,
            touchMode
        );

        drawGridLines(
            overlayCtx,
            effectiveCols,
            cellYOffset,
            translateX,
            translateY,
            width,
            height,
            undefined,
            undefined,
            groupHeaderHeight,
            totalHeaderHeight,
            getRowHeight,
            getRowThemeOverride,
            verticalBorder,
            trailingRowType,
            rows,
            theme,
            true
        );

        overlayCtx.beginPath();
        overlayCtx.moveTo(0, overlayHeight - 0.5);
        overlayCtx.lineTo(width, overlayHeight - 0.5);
        overlayCtx.strokeStyle = blend(
            theme.headerBottomBorderColor ?? theme.horizontalBorderColor ?? theme.borderColor,
            theme.bgHeader
        );
        overlayCtx.stroke();

        if (mustDrawFocusOnHeader) {
            drawFocusRing(
                overlayCtx,
                width,
                height,
                cellYOffset,
                translateX,
                translateY,
                effectiveCols,
                mappedColumns,
                theme,
                totalHeaderHeight,
                selection,
                getRowHeight,
                getCellContent,
                trailingRowType,
                fillHandle,
                fillHandleLocation,
                rows
            );
        }
    };

    // handle damage updates by directly drawing to the target to avoid large blits
    if (damage !== undefined) {
        const doHeaders = damage.hasHeader();
        damage.filterToRegion([
            {
                x: 0,
                y: -2,
                width: Number.MAX_SAFE_INTEGER,
                height: 2,
            },
            {
                x: cellXOffset,
                y: cellYOffset,
                width: effectiveCols.length,
                height: 300,
            },
            {
                x: 0,
                y: cellYOffset,
                width: freezeColumns,
                height: 300,
            },
            {
                x: cellXOffset,
                y: rows - 1,
                width: effectiveCols.length,
                height: 1,
                when: trailingRowType !== "sticky",
            },
        ]);

        if (damage.size > 0) {
            // the reason we unclip as soon as possible is because complex clip regions are hella expensive
            targetCtx.save();
            clipDamage(
                targetCtx,
                effectiveCols,
                width,
                height,
                groupHeaderHeight,
                totalHeaderHeight,
                translateX,
                translateY,
                cellYOffset,
                rows,
                getRowHeight,
                trailingRowType,
                damage,
                true
            );

            targetCtx.fillStyle = theme.bgCell;
            targetCtx.fillRect(0, totalHeaderHeight + 1, width, height - totalHeaderHeight - 1);
            targetCtx.restore();

            // it is important to remember we are not clipped here. This means cells should be careful not to draw over
            // their border when damaging
            drawCells(
                targetCtx,
                effectiveCols,
                mappedColumns,
                height,
                totalHeaderHeight,
                translateX,
                translateY,
                cellYOffset,
                rows,
                getRowHeight,
                getCellContent,
                getGroupDetails,
                getRowThemeOverride,
                disabledRows,
                isFocused,
                drawFocus,
                trailingRowType,
                drawRegions,
                damage,
                selection,
                prelightCells,
                highlightRegions,
                imageLoader,
                spriteManager,
                hoverValues,
                hoverInfo,
                drawCellCallback,
                hyperWrapping,
                theme,
                enqueue,
                renderStateProvider,
                getCellRenderer,
                overrideCursor,
                minimumCellWidth
            );

            const selectionCurrent = selection.current;

            if (
                fillHandle &&
                drawFocus &&
                selectionCurrent !== undefined &&
                // this is why it sometimes fails to draw the handle on damage
                (damage.has(selectionCurrent.cell) ||
                    (fillHandleLocation === "selected-range" && damage.has(rectBottomRight(selectionCurrent.range))))
            ) {
                drawFocusRing(
                    targetCtx,
                    width,
                    height,
                    cellYOffset,
                    translateX,
                    translateY,
                    effectiveCols,
                    mappedColumns,
                    theme,
                    totalHeaderHeight,
                    selection,
                    getRowHeight,
                    getCellContent,
                    trailingRowType,
                    fillHandle,
                    fillHandleLocation,
                    rows
                );
            }
        }

        if (doHeaders) {
            clipDamage(
                overlayCtx,
                effectiveCols,
                width,
                totalHeaderHeight,
                groupHeaderHeight,
                totalHeaderHeight,
                translateX,
                translateY,
                cellYOffset,
                rows,
                getRowHeight,
                trailingRowType,
                damage,
                false
            );
            drawHeaderTexture();
        }
        targetCtx.restore();
        overlayCtx.restore();

        if (mainCtx !== null) {
            mainCtx.fillStyle = theme.bgCell;
            mainCtx.fillRect(0, 0, width, height);
            mainCtx.drawImage(targetCtx.canvas, 0, 0);
        }

        return;
    }

    if (
        canBlit !== true ||
        cellXOffset !== last?.cellXOffset ||
        translateX !== last?.translateX ||
        mustDrawFocusOnHeader !== last?.mustDrawFocusOnHeader
    ) {
        drawHeaderTexture();
    }

    if (canBlit === true) {
        assert(blitSource !== undefined && last !== undefined);
        const { regions } = blitLastFrame(
            targetCtx,
            blitSource,
            last,
            cellXOffset,
            cellYOffset,
            translateX,
            translateY,
            trailingRowType === "sticky",
            width,
            height,
            rows,
            totalHeaderHeight,
            dpr,
            mappedColumns,
            effectiveCols,
            rowHeight,
            doubleBuffer
        );
        drawRegions = regions;
    } else if (canBlit !== false) {
        assert(last !== undefined);
        const resizedCol = canBlit;
        drawRegions = blitResizedCol(
            last,
            cellXOffset,
            cellYOffset,
            translateX,
            translateY,
            width,
            height,
            totalHeaderHeight,
            effectiveCols,
            resizedCol
        );
    }

    overdrawStickyBoundaries(
        targetCtx,
        effectiveCols,
        width,
        height,
        trailingRowType === "sticky",
        rows,
        verticalBorder,
        getRowHeight,
        theme
    );

    // the overdraw may have nuked out our focus ring right edge.
    const focusRedraw = drawFocus
        ? drawFocusRing(
              targetCtx,
              width,
              height,
              cellYOffset,
              translateX,
              translateY,
              effectiveCols,
              mappedColumns,
              theme,
              totalHeaderHeight,
              selection,
              getRowHeight,
              getCellContent,
              trailingRowType,
              fillHandle,
              fillHandleLocation,
              rows
          )
        : undefined;

    const highlightRedraw = drawHighlightRings(
        targetCtx,
        width,
        height,
        cellXOffset,
        cellYOffset,
        translateX,
        translateY,
        mappedColumns,
        freezeColumns,
        headerHeight,
        groupHeaderHeight,
        rowHeight,
        trailingRowType === "sticky",
        rows,
        highlightRegions
    );

    targetCtx.fillStyle = theme.bgCell;
    if (drawRegions.length > 0) {
        targetCtx.beginPath();
        for (const r of drawRegions) {
            targetCtx.rect(r.x, r.y, r.width, r.height);
        }
        targetCtx.clip();
        targetCtx.fill();
        targetCtx.beginPath();
    } else {
        targetCtx.fillRect(0, 0, width, height);
    }

    const spans = drawCells(
        targetCtx,
        effectiveCols,
        mappedColumns,
        height,
        totalHeaderHeight,
        translateX,
        translateY,
        cellYOffset,
        rows,
        getRowHeight,
        getCellContent,
        getGroupDetails,
        getRowThemeOverride,
        disabledRows,
        isFocused,
        drawFocus,
        trailingRowType,
        drawRegions,
        damage,
        selection,
        prelightCells,
        highlightRegions,
        imageLoader,
        spriteManager,
        hoverValues,
        hoverInfo,
        drawCellCallback,
        hyperWrapping,
        theme,
        enqueue,
        renderStateProvider,
        getCellRenderer,
        overrideCursor,
        minimumCellWidth
    );

    drawBlanks(
        targetCtx,
        effectiveCols,
        mappedColumns,
        width,
        height,
        totalHeaderHeight,
        translateX,
        translateY,
        cellYOffset,
        rows,
        getRowHeight,
        getRowThemeOverride,
        selection.rows,
        disabledRows,
        trailingRowType,
        drawRegions,
        damage,
        theme
    );

    drawGridLines(
        targetCtx,
        effectiveCols,
        cellYOffset,
        translateX,
        translateY,
        width,
        height,
        drawRegions,
        spans,
        groupHeaderHeight,
        totalHeaderHeight,
        getRowHeight,
        getRowThemeOverride,
        verticalBorder,
        trailingRowType,
        rows,
        theme
    );

    highlightRedraw?.();
    focusRedraw?.();

    if (isResizing) {
        walkColumns(effectiveCols, 0, translateX, 0, totalHeaderHeight, (c, x) => {
            if (c.sourceIndex === resizeCol) {
                drawColumnResizeOutline(overlayCtx, x + c.width, 0, totalHeaderHeight + 1, theme);
                drawColumnResizeOutline(targetCtx, x + c.width, totalHeaderHeight, height, theme);
                return true;
            }
            return false;
        });
    }

    if (mainCtx !== null) {
        mainCtx.fillStyle = theme.bgCell;
        mainCtx.fillRect(0, 0, width, height);
        mainCtx.drawImage(targetCtx.canvas, 0, 0);
    }

    const lastRowDrawn = getLastRow(
        effectiveCols,
        height,
        totalHeaderHeight,
        translateX,
        translateY,
        cellYOffset,
        rows,
        getRowHeight,
        trailingRowType
    );

    imageLoader?.setWindow(
        {
            x: cellXOffset,
            y: cellYOffset,
            width: effectiveCols.length,
            height: lastRowDrawn - cellYOffset,
        },
        freezeColumns
    );

    lastBlitData.current = {
        cellXOffset,
        cellYOffset,
        translateX,
        translateY,
        mustDrawFocusOnHeader,
        lastBuffer: doubleBuffer ? (targetBuffer === bufferA ? "a" : "b") : undefined,
    };

    targetCtx.restore();
    overlayCtx.restore();
}

type WalkRowsCallback = (
    drawY: number,
    row: number,
    rowHeight: number,
    isSticky: boolean,
    isTrailingRow: boolean
) => boolean | void;

function walkRowsInCol(
    startRow: number,
    drawY: number,
    height: number,
    rows: number,
    getRowHeight: (row: number) => number,
    trailingRowType: TrailingRowType,
    cb: WalkRowsCallback
): void {
    let y = drawY;
    let row = startRow;
    let doSticky = trailingRowType === "sticky";
    while (y < height || doSticky) {
        const doingSticky = doSticky && y >= height;
        if (doingSticky) {
            doSticky = false;
            row = rows - 1;
        }
        const rh = getRowHeight(row);

        if (doingSticky) {
            y = height - rh;
        }

        const isMovedStickyRow = doSticky && row === rows - 1;

        if (!isMovedStickyRow && cb(y, row, rh, doingSticky, trailingRowType !== "none" && row === rows - 1) === true) {
            break;
        }

        if (doingSticky) {
            break;
        }
        y += rh;
        row++;
    }
}

type WalkColsCallback = (
    col: MappedGridColumn,
    drawX: number,
    drawY: number,
    clipX: number,
    startRow: number
) => boolean | void;

function walkColumns(
    effectiveCols: readonly MappedGridColumn[],
    cellYOffset: number,
    translateX: number,
    translateY: number,
    totalHeaderHeight: number,
    cb: WalkColsCallback
): void {
    let x = 0;
    let clipX = 0; // this tracks the total width of sticky cols
    const drawY = totalHeaderHeight + translateY;
    for (const c of effectiveCols) {
        const drawX = c.sticky ? clipX : x + translateX;
        if (cb(c, drawX, drawY, clipX, cellYOffset) === true) {
            break;
        }

        x += c.width;
        clipX += c.sticky ? c.width : 0;
    }
}

// this should not be item, it is [startInclusive, endInclusive]
type WalkGroupsCallback = (colSpan: Item, group: string, x: number, y: number, width: number, height: number) => void;
function walkGroups(
    effectiveCols: readonly MappedGridColumn[],
    width: number,
    translateX: number,
    groupHeaderHeight: number,
    cb: WalkGroupsCallback
): void {
    let x = 0;
    let clipX = 0;
    for (let index = 0; index < effectiveCols.length; index++) {
        const startCol = effectiveCols[index];

        let end = index + 1;
        let boxWidth = startCol.width;
        if (startCol.sticky) {
            clipX += boxWidth;
        }
        while (
            end < effectiveCols.length &&
            isGroupEqual(effectiveCols[end].group, startCol.group) &&
            effectiveCols[end].sticky === effectiveCols[index].sticky
        ) {
            const endCol = effectiveCols[end];
            boxWidth += endCol.width;
            end++;
            index++;
            if (endCol.sticky) {
                clipX += endCol.width;
            }
        }

        const t = startCol.sticky ? 0 : translateX;
        const localX = x + t;
        const delta = startCol.sticky ? 0 : Math.max(0, clipX - localX);
        const w = Math.min(boxWidth - delta, width - (localX + delta));
        cb(
            [startCol.sourceIndex, effectiveCols[end - 1].sourceIndex],
            startCol.group ?? "",
            localX + delta,
            0,
            w,
            groupHeaderHeight
        );

        x += boxWidth;
    }
}
